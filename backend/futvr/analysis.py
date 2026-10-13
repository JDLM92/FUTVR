"""Actual optional detection. Automatic calibration is deliberately unavailable."""
from functools import lru_cache
from datetime import datetime, timezone
from io import BytesIO
import threading
import uuid
import os
from pathlib import Path
import numpy as np
from PIL import Image
from fastapi import HTTPException
from .config import Settings
from .models import CalibrationRequest
from .store import Store
from .storage import Storage

MODEL_LOCK = threading.Lock()


@lru_cache(maxsize=1)
def detector():
    from rfdetr import RFDETRLarge
    device = os.getenv("RFDETR_DEVICE")
    weights = os.getenv("RFDETR_WEIGHTS_PATH")
    options = {"device": device} if device else {}
    if weights:
        path = Path(weights).expanduser().resolve()
        if not path.is_file():
            raise RuntimeError("Configured RFDETR_WEIGHTS_PATH does not exist")
        options["pretrain_weights"] = str(path)
    return RFDETRLarge(**options)


def torso_color(image, box):
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    crop = image.crop((int(x1 + .2*w), int(y1 + .15*h), int(x1 + .8*w), int(y1 + .55*h))).resize((12, 12)).convert("RGB")
    pixels = np.asarray(crop).reshape(-1, 3).astype(float)
    # Exclude bright grass where possible; neutral/white kits remain useful.
    keep = ~((pixels[:, 1] > pixels[:, 0] * 1.25) & (pixels[:, 1] > pixels[:, 2] * 1.2))
    return np.median(pixels[keep] if keep.any() else pixels, axis=0)


def suggest_teams(colors):
    if len(colors) < 4:
        return ["unknown"] * len(colors)
    data = np.array(colors)
    first = data[0]
    second = data[np.argmax(np.linalg.norm(data-first, axis=1))]
    centers = np.array([first, second])
    if np.linalg.norm(first-second) < 40:
        return ["unknown"] * len(colors)
    labels = np.zeros(len(colors), dtype=int)
    for _ in range(12):
        new_labels = np.argmin(np.linalg.norm(data[:, None, :] - centers[None, :, :], axis=2), axis=1)
        if all((new_labels == i).any() for i in (0, 1)):
            centers = np.array([data[new_labels == i].mean(axis=0) for i in (0, 1)])
        labels = new_labels
    return ["a" if label == 0 else "b" for label in labels]


def detect_image(content: bytes):
    image = Image.open(BytesIO(content)).convert("RGB")
    with MODEL_LOCK:
        predictions = detector().predict(image, threshold=.3)
    try:
        from rfdetr.assets.coco_classes import COCO_CLASSES
    except ImportError:
        # RF-DETR moved this module in later 1.x releases.
        from rfdetr.util.coco_classes import COCO_CLASSES
    detections, colors, player_indices = [], [], []
    for box, class_id in zip(predictions.xyxy, predictions.class_id):
        name = COCO_CLASSES.get(int(class_id), "")
        if name not in {"person", "sports ball"}:
            continue
        normalized = [float(np.clip(box[0]/image.width, 0, 1)), float(np.clip(box[1]/image.height, 0, 1)), float(np.clip(box[2]/image.width, 0, 1)), float(np.clip(box[3]/image.height, 0, 1))]
        role = "ball" if name == "sports ball" else "player"
        x = (normalized[0]+normalized[2])/2
        y = (normalized[1]+normalized[3])/2 if role == "ball" else normalized[3]
        item = {"id": str(uuid.uuid4()), "role": role, "team": "unknown", "imagePoint": {"x": x, "y": y}, "needsReview": True, "box": normalized}
        detections.append(item)
        if role == "player":
            player_indices.append(len(detections)-1)
            colors.append(torso_color(image, box))
    for index, team in zip(player_indices, suggest_teams(colors)):
        detections[index]["team"] = team
    return detections[:60]


def run_analysis(settings: Settings, store: Store, storage: Storage, job_id: str):
    job = store.get("analyses", job_id)
    if not job or job["status"] not in {"queued", "processing"}:
        return
    job.update(status="processing", stage="Finding visible players")
    store.replace("analyses", job)
    try:
        asset = store.get("assets", job["asset_id"])
        if not asset:
            raise ValueError("Source image was deleted")
        detections = []
        notice = "Automatic detection is not configured. Add players and the ball manually, then align the pitch using four landmarks."
        if settings.rfdetr_enabled:
            try:
                detections = detect_image(storage.read(asset))
                notice = "Review the visible-player suggestions and team colours. Align the pitch with four landmarks; the ball may be missing or airborne."
            except (ImportError, ModuleNotFoundError):
                notice = "RF-DETR is enabled but its dependencies are unavailable. Add players manually and use guided pitch alignment."
        job = store.get("analyses", job_id)
        if not job:
            return
        job.update(status="completed", stage="Ready to review", result={"detections": detections, "calibration": {"status": "unavailable"}, "notice": notice})
        store.replace("analyses", job)
    except Exception:
        job = store.get("analyses", job_id)
        if job:
            job.update(status="failed", stage="Analysis failed", error="Could not analyse this image. Retry, or continue with manual placement.")
            store.replace("analyses", job)


def solve_calibration(request: CalibrationRequest):
    image = np.array([[p.image.x, p.image.y] for p in request.landmarks], dtype=float)
    pitch = np.array([[p.pitch.x, p.pitch.y] for p in request.landmarks], dtype=float)
    if len(np.unique(image, axis=0)) < 4 or len(np.unique(pitch, axis=0)) < 4:
        raise HTTPException(422, "Choose four distinct pitch landmarks")
    if np.linalg.matrix_rank(np.column_stack([image, np.ones(len(image))])) < 3 or np.linalg.matrix_rank(np.column_stack([pitch, np.ones(len(pitch))])) < 3:
        raise HTTPException(422, "Landmarks must not lie on one line")

    def normalize(points):
        center = points.mean(axis=0)
        mean_distance = np.linalg.norm(points-center, axis=1).mean()
        if mean_distance < 1e-7:
            raise HTTPException(422, "Landmarks are too close together")
        scale = np.sqrt(2)/mean_distance
        transform = np.array([[scale,0,-scale*center[0]], [0,scale,-scale*center[1]], [0,0,1]])
        homogeneous = np.column_stack([points, np.ones(len(points))])
        return (transform @ homogeneous.T).T[:, :2], transform

    src, t_src = normalize(image)
    dst, t_dst = normalize(pitch)
    rows = []
    for (x,y), (u,v) in zip(src, dst):
        rows.extend([[-x,-y,-1,0,0,0,u*x,u*y,u], [0,0,0,-x,-y,-1,v*x,v*y,v]])
    matrix = np.array(rows)
    if np.linalg.matrix_rank(matrix) < 8:
        raise HTTPException(422, "Landmarks do not define a valid field alignment")
    _, _, vt = np.linalg.svd(matrix, full_matrices=True)
    h = np.linalg.inv(t_dst) @ vt[-1].reshape(3,3) @ t_src
    if abs(h[2,2]) < 1e-10 or abs(np.linalg.det(h)) < 1e-10:
        raise HTTPException(422, "Landmarks do not define a valid field alignment")
    h /= h[2,2]
    projected = (h @ np.column_stack([image, np.ones(len(image))]).T).T
    if np.any(abs(projected[:,2]) < 1e-8):
        raise HTTPException(422, "Field alignment is unstable")
    error = np.linalg.norm(projected[:,:2]/projected[:,2,None]-pitch, axis=1)
    if not np.all(np.isfinite(h)) or np.max(error) > 3:
        raise HTTPException(422, "Landmarks disagree; check their corresponding pitch locations")
    return {"status": "confirmed", "matrix": h.flatten().tolist(), "landmarks": [p.model_dump() for p in request.landmarks]}

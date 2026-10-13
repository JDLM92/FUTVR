from copy import deepcopy
from datetime import datetime, timezone
from collections import defaultdict, deque
from contextlib import asynccontextmanager
import asyncio
import secrets
import threading
import time
import uuid
from fastapi import FastAPI, BackgroundTasks, Depends, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from .config import Settings
from .models import AddComment, AnalysisJob, Calibration, CalibrationRequest, Comment, EmailRequest, Publication, PublishRequest, RefreshRequest, SaveDraft, Scene, VerifyRequest
from .store import Store
from .auth import Auth
from .storage import Storage, normalize_image
from .analysis import run_analysis, solve_calibration

bearer = HTTPBearer(auto_error=False)


class RateLimiter:
    def __init__(self):
        self.events = defaultdict(deque)
        self.lock = threading.Lock()

    def check(self, bucket, key, limit, seconds=60):
        now = time.monotonic()
        with self.lock:
            events = self.events[(bucket, key)]
            while events and events[0] <= now-seconds:
                events.popleft()
            if len(events) >= limit:
                raise HTTPException(429, "Too many requests; try again shortly", headers={"Retry-After": str(seconds)})
            events.append(now)
            if len(self.events) > 20_000:
                for stale_key in list(self.events):
                    if not self.events[stale_key] or self.events[stale_key][-1] < now-3600:
                        del self.events[stale_key]


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def create_app(settings: Settings | None = None):
    settings = settings or Settings.from_env()
    settings.validate()
    store, limiter = Store(settings), RateLimiter()
    auth, storage = Auth(settings, store), Storage(settings, store)

    @asynccontextmanager
    async def lifespan(application):
        # A local restart resumes queued jobs and fails interrupted work honestly.
        if settings.job_backend == "local":
            for job in store.list("analyses", limit=10_000):
                if job["status"] == "queued":
                    asyncio.create_task(asyncio.to_thread(run_analysis, settings, store, storage, job["id"]))
                elif job["status"] == "processing":
                    job.update(status="failed", error="The analysis worker restarted. Retry this image.")
                    store.replace("analyses", job)
        yield
        for service in (store, auth, storage):
            if hasattr(service, "client"):
                service.client.close()

    application = FastAPI(title="FutVR API", version="0.1.0", lifespan=lifespan)
    application.add_middleware(CORSMiddleware, allow_origins=list(settings.origins), allow_credentials=False, allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Authorization", "Content-Type"])
    application.state.store, application.state.settings = store, settings

    @application.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        return response

    def token(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
        return credentials.credentials if credentials else None

    def user(access_token=Depends(token)):
        return auth.user(access_token)

    def registered(current_user=Depends(user)):
        if current_user["isAnonymous"]:
            raise HTTPException(403, "Sign in with email to publish or comment")
        return current_user

    def owner_record(table, record_id, owner_id):
        record = store.get(table, record_id)
        if not record or record.get("owner_id") != owner_id:
            raise HTTPException(404, "Record not found")
        return record

    def publication_record(publication_id):
        record = store.get("publications", publication_id)
        if not record:
            raise HTTPException(404, "Publication not found")
        return record

    def fresh_scene(scene):
        scene = deepcopy(scene)
        source = scene.get("source")
        if source and source.get("assetId"):
            asset = store.get("assets", source["assetId"])
            if asset:
                source["url"] = storage.sign(asset)["url"]
            else:
                scene.pop("source", None)
        return scene

    def public_view(record):
        return {"id": record["id"], "scene": fresh_scene(record["scene"]), "ownerId": record["owner_id"], "createdAt": record["createdAt"], "includeSource": record["includeSource"]}

    def job_view(record):
        result = {key: record[key] for key in ("id", "status", "stage", "error", "result") if key in record}
        asset = store.get("assets", record["asset_id"])
        if asset:
            result["asset"] = storage.view(asset)
        return result

    def client_ip(request):
        # Do not trust arbitrary X-Forwarded-For headers. Configure proxy trust at deployment.
        return request.client.host if request.client else "unknown"

    @application.get("/api/health")
    def health():
        return {"status": "ok", "environment": settings.environment, "persistence": "sqlite" if settings.local else "supabase", "detectionConfigured": settings.rfdetr_enabled, "automaticCalibration": False, "jobBackend": settings.job_backend}

    @application.post("/api/auth/guest")
    def create_guest(request: Request):
        limiter.check("guest", client_ip(request), 20)
        return auth.guest()

    @application.post("/api/auth/request-code")
    def request_code(body: EmailRequest, request: Request):
        limiter.check("otp-ip", client_ip(request), 10, 300)
        limiter.check("otp-email", body.email, 3, 300)
        return auth.request_code(body.email)

    @application.post("/api/auth/verify")
    def verify(body: VerifyRequest, request: Request, access_token=Depends(token)):
        limiter.check("verify-ip", client_ip(request), 15, 300)
        return auth.verify(body.email, body.code, body.guestToken or access_token)

    @application.post("/api/auth/refresh")
    def refresh(body: RefreshRequest, request: Request):
        limiter.check("refresh", client_ip(request), 30)
        return auth.refresh(body.refreshToken)

    @application.get("/api/auth/me")
    def me(current_user=Depends(user)):
        return current_user

    @application.post("/api/auth/logout", status_code=204)
    def logout(current_user=Depends(user), access_token=Depends(token)):
        auth.logout(access_token)
        return Response(status_code=204)

    async def execute(job_id):
        if settings.job_backend == "modal":
            try:
                import modal
                worker = modal.Function.from_name("futvr", "analyse_job")
                await worker.spawn.aio(job_id)
            except Exception:
                record = store.get("analyses", job_id)
                if record:
                    record.update(status="failed", error="The analysis worker is unavailable. Use manual placement or retry later.")
                    store.replace("analyses", record)
        else:
            await asyncio.to_thread(run_analysis, settings, store, storage, job_id)

    @application.post("/api/analyses", response_model=AnalysisJob, response_model_exclude_none=True, status_code=202)
    async def analyse(background: BackgroundTasks, file: UploadFile = File(...), current_user=Depends(user)):
        limiter.check("upload", current_user["id"], 8, 300)
        if file.content_type not in {"image/jpeg", "image/png", "image/webp", "application/octet-stream"}:
            raise HTTPException(415, "Upload a JPEG, PNG, or WebP image")
        content = await file.read(settings.max_upload_bytes + 1)
        await file.close()
        normalized, width, height = await asyncio.to_thread(normalize_image, content, settings)
        asset = storage.create(current_user["id"], normalized, width, height)
        record = {"id": str(uuid.uuid4()), "owner_id": current_user["id"], "asset_id": asset["id"], "status": "queued", "stage": "Waiting for analysis", "createdAt": now_iso(), "created_ts": time.time()}
        try:
            store.reserve_analysis(record)
        except Exception:
            storage.delete(asset)
            raise
        result = job_view(record)
        background.add_task(execute, record["id"])
        return result

    @application.get("/api/analyses/{job_id}", response_model=AnalysisJob, response_model_exclude_none=True)
    def get_analysis(job_id: str, current_user=Depends(user)):
        record = owner_record("analyses", job_id, current_user["id"])
        if record["status"] in {"queued", "processing"} and record["created_ts"] < time.time()-settings.job_timeout_seconds:
            record.update(status="failed", error="Analysis timed out. Retry, or continue with manual placement.")
            store.replace("analyses", record)
        return job_view(record)

    @application.delete("/api/analyses/{job_id}", status_code=204)
    def delete_analysis(job_id: str, current_user=Depends(user)):
        owner_record("analyses", job_id, current_user["id"])
        store.delete("analyses", job_id, current_user["id"])
        return Response(status_code=204)

    @application.post("/api/calibrations", response_model=Calibration, response_model_exclude_none=True)
    def calibrate(body: CalibrationRequest, current_user=Depends(user)):
        limiter.check("calibration", current_user["id"], 60)
        return solve_calibration(body)

    @application.get("/api/assets/{asset_id}/url")
    def asset_url(asset_id: str, current_user=Depends(user)):
        return storage.sign(owner_record("assets", asset_id, current_user["id"]))

    @application.get("/api/assets/{asset_id}")
    def local_asset(asset_id: str, token: str | None = None):
        asset = storage.authorized_local_asset(asset_id, token)
        return Response(content=storage.read(asset), media_type="image/png", headers={"Content-Disposition": "inline; filename=source.png"})

    @application.delete("/api/assets/{asset_id}", status_code=204)
    def delete_asset(asset_id: str, current_user=Depends(user)):
        asset = owner_record("assets", asset_id, current_user["id"])
        for kind in ("drafts", "publications"):
            if any(row["scene"].get("source", {}).get("assetId") == asset_id for row in store.list(kind, {"owner_id": current_user["id"]}, limit=10_000)):
                raise HTTPException(409, "Remove the source from drafts and delete publications containing it before deleting the image")
        storage.delete(asset)
        return Response(status_code=204)

    @application.get("/api/drafts", response_model=list[Scene], response_model_exclude_none=True)
    def drafts(current_user=Depends(user)):
        return [fresh_scene(row["scene"]) for row in store.list("drafts", {"owner_id": current_user["id"]})]

    @application.get("/api/drafts/{scene_id}", response_model=Scene, response_model_exclude_none=True)
    def draft(scene_id: str, current_user=Depends(user)):
        return fresh_scene(owner_record("drafts", scene_id, current_user["id"])["scene"])

    @application.put("/api/drafts/{scene_id}", response_model=Scene, response_model_exclude_none=True)
    def save(scene_id: str, body: SaveDraft, current_user=Depends(user)):
        if not settings.local and current_user["isAnonymous"]:
            raise HTTPException(403, "Sign in with email to save a cloud draft")
        limiter.check("save", current_user["id"], 120)
        if scene_id != body.scene.id:
            raise HTTPException(422, "Scene ID and URL must match")
        scene = body.scene.model_dump(mode="json", exclude_none=True)
        if scene.get("source"):
            asset_id = scene["source"].get("assetId")
            if not asset_id:
                raise HTTPException(422, "A saved source must reference a private uploaded asset")
            asset = owner_record("assets", asset_id, current_user["id"])
            scene["source"].update(width=asset["width"], height=asset["height"], url=storage.sign(asset)["url"])
        existing = store.get("drafts", scene_id)
        if existing and existing["owner_id"] != current_user["id"]:
            raise HTTPException(404, "Draft not found")
        if existing and existing["revision"] != body.expectedRevision:
            raise HTTPException(409, {"message": "Draft has changed; reload before saving", "currentRevision": existing["revision"]})
        if not existing and body.expectedRevision != 0:
            raise HTTPException(409, {"message": "Draft does not exist; save as a new draft", "currentRevision": 0})
        scene.update(revision=body.expectedRevision+1, updatedAt=now_iso())
        if existing:
            scene["createdAt"] = existing["scene"]["createdAt"]
        record = {"id": scene_id, "owner_id": current_user["id"], "revision": scene["revision"], "scene": scene, "createdAt": scene["createdAt"]}
        if existing:
            if not store.replace("drafts", record, expected_revision=body.expectedRevision, owner_id=current_user["id"]):
                raise HTTPException(409, "Draft changed during save; reload before retrying")
        else:
            store.insert("drafts", record)
        return scene

    @application.delete("/api/drafts/{scene_id}", status_code=204)
    def delete_draft(scene_id: str, current_user=Depends(user)):
        owner_record("drafts", scene_id, current_user["id"])
        store.delete("drafts", scene_id, current_user["id"])
        return Response(status_code=204)

    @application.post("/api/drafts/{scene_id}/publish", response_model=Publication, response_model_exclude_none=True, status_code=201)
    def publish(scene_id: str, body: PublishRequest, current_user=Depends(registered)):
        limiter.check("publish", current_user["id"], 10)
        draft = owner_record("drafts", scene_id, current_user["id"])
        scene = deepcopy(draft["scene"])
        if not body.includeSource:
            scene.pop("source", None)
        elif scene.get("source"):
            owner_record("assets", scene["source"]["assetId"], current_user["id"])
        record = {"id": secrets.token_urlsafe(9), "owner_id": current_user["id"], "revision": scene["revision"], "scene": scene, "createdAt": now_iso(), "includeSource": body.includeSource}
        store.insert("publications", record)
        return public_view(record)

    @application.get("/api/publications", response_model=list[Publication], response_model_exclude_none=True)
    def owner_publications(current_user=Depends(user)):
        return [public_view(row) for row in store.list("publications", {"owner_id": current_user["id"]})]

    @application.get("/api/publications/{publication_id}", response_model=Publication, response_model_exclude_none=True)
    def get_publication(publication_id: str):
        return public_view(publication_record(publication_id))

    @application.delete("/api/publications/{publication_id}", status_code=204)
    def delete_publication(publication_id: str, current_user=Depends(user)):
        owner_record("publications", publication_id, current_user["id"])
        for row in store.list("comments", {"publication_id": publication_id}, limit=10_000):
            store.delete("comments", row["id"])
        store.delete("publications", publication_id, current_user["id"])
        return Response(status_code=204)

    def comment_view(record):
        return {key: record[key] for key in ("id", "publicationId", "parentId", "author", "authorId", "body", "anchor", "createdAt") if key in record}

    @application.get("/api/publications/{publication_id}/comments", response_model=list[Comment], response_model_exclude_none=True)
    def get_comments(publication_id: str):
        publication_record(publication_id)
        rows = store.list("comments", {"publication_id": publication_id}, limit=1000)
        return [comment_view(row) for row in reversed(rows)]

    @application.post("/api/publications/{publication_id}/comments", response_model=Comment, response_model_exclude_none=True, status_code=201)
    def add_comment(publication_id: str, body: AddComment, current_user=Depends(registered)):
        limiter.check("comment", current_user["id"], 10)
        publication = publication_record(publication_id)
        scene = publication["scene"]
        duration = sum(frame["durationMs"]+frame["holdMs"] for frame in scene["keyframes"])
        if body.anchor.timeMs > duration:
            raise HTTPException(422, "Comment time exceeds the published animation")
        if body.anchor.actorId and body.anchor.actorId not in {actor["id"] for actor in scene["actors"]}:
            raise HTTPException(422, "Comment actor is not in this publication")
        if body.anchor.point and not (0 <= body.anchor.point.x <= scene["pitch"]["length"] and 0 <= body.anchor.point.y <= scene["pitch"]["width"]):
            raise HTTPException(422, "Comment point must be on the pitch")
        if body.parentId:
            parent = store.get("comments", body.parentId)
            if not parent or parent["publication_id"] != publication_id:
                raise HTTPException(422, "Reply must belong to the same publication")
            if parent.get("parentId"):
                raise HTTPException(422, "Reply to the original comment instead")
        record = {"id": str(uuid.uuid4()), "owner_id": current_user["id"], "publication_id": publication_id, "parent_id": body.parentId, "publicationId": publication_id, "author": (current_user.get("email") or "analyst").split("@")[0][:60], "authorId": current_user["id"], "body": body.body, "anchor": body.anchor.model_dump(exclude_none=True), "createdAt": now_iso(), "sceneRevision": scene["revision"]}
        if body.parentId:
            record["parentId"] = body.parentId
        store.insert("comments", record)
        return comment_view(record)

    @application.delete("/api/publications/{publication_id}/comments/{comment_id}", status_code=204)
    def delete_comment(publication_id: str, comment_id: str, current_user=Depends(user)):
        publication = publication_record(publication_id)
        record = store.get("comments", comment_id)
        if not record or record["publication_id"] != publication_id:
            raise HTTPException(404, "Comment not found")
        if current_user["id"] not in {record["owner_id"], publication["owner_id"]}:
            raise HTTPException(403, "Only the author or publication owner can remove this comment")
        # Preserve replies when an original comment is moderated.
        record.update(body="[Comment removed]", author="Removed", authorId="removed", removed=True)
        store.replace("comments", record)
        return Response(status_code=204)

    return application


app = create_app()

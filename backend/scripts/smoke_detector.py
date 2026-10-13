"""Run real CPU detection on an image; no cloud or API credentials are used."""
import argparse
from collections import Counter
from io import BytesIO
import json
import os
from pathlib import Path
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--crop", nargs=4, type=int, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    parser.add_argument("--output", type=Path, default=Path("/tmp/futvr-detector-smoke"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("RFDETR_DEVICE", "cpu")
    os.environ.setdefault("RF_HOME", str(args.output / "models"))
    os.environ.setdefault("HF_HOME", str(args.output / "huggingface"))
    os.environ.setdefault("TORCH_HOME", str(args.output / "torch"))
    os.environ.setdefault("MPLCONFIGDIR", str(args.output / "matplotlib"))
    from PIL import Image, ImageOps, ImageDraw
    import torch
    torch.set_num_threads(4)
    from futvr.analysis import detector, detect_image
    image = ImageOps.exif_transpose(Image.open(args.image)).convert("RGB")
    if args.crop:
        image = image.crop(tuple(args.crop))
    image.save(args.output / "input-crop.png")
    content = BytesIO()
    image.save(content, "PNG")
    print(json.dumps({"phase": "loading", "device": os.environ["RFDETR_DEVICE"], "inputSize": list(image.size)}), flush=True)
    started = time.perf_counter()
    model = detector()
    load_seconds = time.perf_counter() - started
    print(json.dumps({"phase": "loaded", "seconds": round(load_seconds, 3), "modelDevice": str(model.model.device)}), flush=True)
    started = time.perf_counter()
    detections = detect_image(content.getvalue())
    inference_seconds = time.perf_counter()-started
    summary = {"device": os.environ["RFDETR_DEVICE"], "model": "RFDETRLarge", "inputSize": list(image.size), "crop": args.crop, "modelLoadSeconds": round(load_seconds, 3), "inferenceSeconds": round(inference_seconds, 3), "counts": dict(Counter(d["role"] for d in detections)), "teamSuggestions": dict(Counter(d["team"] for d in detections if d["role"] == "player")), "detections": detections, "note": "One supplied screenshot; this is a smoke check, not an accuracy or latency benchmark."}
    (args.output / "result.json").write_text(json.dumps(summary, indent=2))
    draw = ImageDraw.Draw(image)
    for index, detection in enumerate(detections):
        box = detection["box"]
        pixels = (box[0]*image.width, box[1]*image.height, box[2]*image.width, box[3]*image.height)
        color = {"a": "#ff6775", "b": "#37b6ff", "unknown": "#ffdc64"}.get(detection["team"], "white")
        draw.rectangle(pixels, outline=color, width=3)
        point = detection["imagePoint"]
        x,y = point["x"]*image.width, point["y"]*image.height
        draw.ellipse((x-4,y-4,x+4,y+4), fill=color)
        draw.text((pixels[0], max(0, pixels[1]-16)), f"{index+1}: {detection['role']}", fill=color)
    image.save(args.output / "detection-overlay.png")
    print(json.dumps({key:value for key,value in summary.items() if key != "detections"}), flush=True)


if __name__ == "__main__":
    main()

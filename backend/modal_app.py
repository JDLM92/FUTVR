"""Deployment entry point. Running/importing this file does not deploy it.

From backend/: modal deploy modal_app.py
Requires an existing Modal secret named futvr-production and applied Supabase SQL.
"""
import modal

app = modal.App("futvr")


def cache_official_weights():
    """Runs during an explicitly requested deployment's image build, not on import."""
    from pathlib import Path
    from rfdetr.assets.model_weights import download_pretrain_weights
    path = Path("/opt/futvr-models/rf-detr-large-2026.pth")
    path.parent.mkdir(parents=True, exist_ok=True)
    download_pretrain_weights(str(path))


base = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi>=0.115,<1", "uvicorn>=0.32,<1", "pydantic>=2.9,<3", "python-multipart>=0.0.18", "Pillow>=11,<13", "httpx>=0.28,<1", "numpy>=2,<3")
    .add_local_python_source("futvr")
)
gpu_image = (
    base.apt_install("libgl1", "libglib2.0-0")
    .pip_install("rfdetr==1.11.2")
    .env({"RF_HOME": "/opt/futvr-models", "RFDETR_WEIGHTS_PATH": "/opt/futvr-models/rf-detr-large-2026.pth"})
    .run_function(cache_official_weights)
)
secret = modal.Secret.from_name("futvr-production")


@app.function(image=gpu_image, gpu="T4", secrets=[secret], timeout=300, max_containers=4, scaledown_window=120)
def analyse_job(job_id: str):
    """Durable asynchronous worker; records its actual result in Supabase."""
    from futvr.config import Settings
    from futvr.store import Store
    from futvr.storage import Storage
    from futvr.analysis import run_analysis
    settings = Settings.from_env()
    if settings.local:
        raise RuntimeError("Modal jobs require FUTVR_ENV=production and persistent Supabase storage")
    store = Store(settings)
    storage = Storage(settings, store)
    try:
        run_analysis(settings, store, storage, job_id)
    finally:
        store.client.close()
        storage.client.close()


@app.function(image=base, secrets=[secret], timeout=120, max_containers=1, scaledown_window=300)
@modal.concurrent(max_inputs=30)
@modal.asgi_app()
def api():
    # One API container bounds the in-memory authentication/request limiter.
    # Analysis admission itself is atomic in Postgres across all workers.
    from futvr.config import Settings
    settings = Settings.from_env()
    if settings.local or settings.job_backend != "modal":
        raise RuntimeError("Modal API requires FUTVR_ENV=production and FUTVR_JOB_BACKEND=modal")
    from futvr.api import app as web_app
    return web_app

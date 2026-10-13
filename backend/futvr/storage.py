from datetime import datetime, timezone
from io import BytesIO
import secrets
import uuid
import warnings
from pathlib import Path
from urllib.parse import quote
import httpx
from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from .auth import digest
from .config import Settings
from .store import Store


def normalize_image(content: bytes, settings: Settings):
    if not content or len(content) > settings.max_upload_bytes:
        raise HTTPException(413, "Image must be between 1 byte and 10 MB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as image:
                if image.format not in {"JPEG", "PNG", "WEBP"}:
                    raise HTTPException(415, "Upload a JPEG, PNG, or WebP image")
                if getattr(image, "n_frames", 1) != 1:
                    raise HTTPException(415, "Animated images are not supported")
                if image.width * image.height > settings.max_pixels or image.width < 64 or image.height < 64 or image.width > 24_000 or image.height > 24_000:
                    raise HTTPException(422, "Image dimensions must be at least 64×64 and at most 24 megapixels")
                image.load()
                normalized = ImageOps.exif_transpose(image).convert("RGB")
                # Write only decoded pixels; EXIF, metadata, and trailing data are discarded.
                output = BytesIO()
                normalized.save(output, "PNG", optimize=True)
                return output.getvalue(), normalized.width, normalized.height
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(415, "File is not a valid supported image") from exc


class Storage:
    def __init__(self, settings: Settings, store: Store):
        self.settings, self.store = settings, store
        if settings.local:
            self.asset_dir = settings.data_dir / "assets"
            self.asset_dir.mkdir(parents=True, exist_ok=True)
        else:
            self.client = httpx.Client(timeout=60, headers=settings.admin_headers)

    def object_url(self, key):
        return f"{self.settings.supabase_url}/storage/v1/object/{quote(self.settings.storage_bucket, safe='')}/{quote(key, safe='/')}"

    def create(self, owner_id, content, width, height):
        asset_id = str(uuid.uuid4())
        key = f"{owner_id}/{asset_id}.png"
        if self.settings.local:
            (self.asset_dir / f"{asset_id}.png").write_bytes(content)
        else:
            try:
                result = self.client.post(self.object_url(key), content=content, headers={"Content-Type": "image/png", "x-upsert": "false"})
                result.raise_for_status()
            except httpx.HTTPError as exc:
                raise HTTPException(503, "Private image storage is unavailable; verify the configured bucket") from exc
        asset = {"id": asset_id, "owner_id": owner_id, "storage_key": key, "width": width, "height": height, "createdAt": datetime.now(timezone.utc).isoformat()}
        try:
            self.store.insert("assets", asset)
        except Exception:
            self.remove_bytes(asset)
            raise
        return asset

    def read(self, asset):
        if self.settings.local:
            try:
                return (self.asset_dir / f"{asset['id']}.png").read_bytes()
            except FileNotFoundError as exc:
                raise HTTPException(404, "Source image is no longer available") from exc
        try:
            result = self.client.get(self.object_url(asset["storage_key"]))
            result.raise_for_status()
            return result.content
        except httpx.HTTPError as exc:
            raise HTTPException(503, "Source image is temporarily unavailable") from exc

    def sign(self, asset):
        expires = datetime.now(timezone.utc).timestamp() + self.settings.asset_url_ttl
        if self.settings.local:
            token = secrets.token_urlsafe(32)
            self.store.insert("asset_tokens", {"id": digest(token), "owner_id": asset["owner_id"], "asset_id": asset["id"], "expires_at": expires})
            url = f"{self.settings.public_api_url}/api/assets/{asset['id']}?token={token}"
        else:
            try:
                path = f"{self.settings.supabase_url}/storage/v1/object/sign/{quote(self.settings.storage_bucket, safe='')}/{quote(asset['storage_key'], safe='/')}"
                response = self.client.post(path, json={"expiresIn": self.settings.asset_url_ttl})
                response.raise_for_status()
                payload = response.json()
                signed = payload.get("signedURL") or payload.get("signedUrl")
                if not signed:
                    raise ValueError("Missing signed URL")
                url = signed if signed.startswith("https://") else f"{self.settings.supabase_url}/storage/v1{signed}"
            except (httpx.HTTPError, ValueError) as exc:
                raise HTTPException(503, "Could not create a private image URL") from exc
        return {"url": url, "expiresAt": datetime.fromtimestamp(expires, timezone.utc).isoformat()}

    def view(self, asset):
        return {"id": asset["id"], "width": asset["width"], "height": asset["height"], **self.sign(asset)}

    def authorized_local_asset(self, asset_id, token):
        if not self.settings.local or not token:
            raise HTTPException(404, "Image not found")
        record = self.store.get("asset_tokens", digest(token))
        if not record or record["asset_id"] != asset_id or record["expires_at"] <= datetime.now(timezone.utc).timestamp():
            raise HTTPException(404, "Image link expired or is invalid")
        asset = self.store.get("assets", asset_id)
        if not asset:
            raise HTTPException(404, "Image not found")
        return asset

    def remove_bytes(self, asset):
        if self.settings.local:
            (self.asset_dir / f"{asset['id']}.png").unlink(missing_ok=True)
        else:
            try:
                result = self.client.delete(f"{self.settings.supabase_url}/storage/v1/object/{quote(self.settings.storage_bucket, safe='')}", json={"prefixes": [asset["storage_key"]]})
                result.raise_for_status()
            except httpx.HTTPError as exc:
                raise HTTPException(503, "Could not delete the private image") from exc

    def delete(self, asset):
        self.remove_bytes(asset)
        self.store.delete("assets", asset["id"])
        for token in self.store.list("asset_tokens", {"owner_id": asset["owner_id"]}, limit=10_000):
            if token["asset_id"] == asset["id"]:
                self.store.delete("asset_tokens", token["id"])

from copy import deepcopy
from datetime import datetime, timezone
from io import BytesIO
from urllib.parse import urlsplit
import math
import re
import time
import uuid
import pytest
from PIL import Image
from fastapi.testclient import TestClient
from futvr.api import create_app
from futvr.config import Settings
from futvr.auth import Auth


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path, public_api_url="http://testserver")
    with TestClient(create_app(settings)) as value:
        yield value


def guest(client):
    response = client.post("/api/auth/guest")
    assert response.status_code == 200
    return response.json()


def headers(session):
    return {"Authorization": f"Bearer {session['accessToken']}"}


def login(client, email="coach@example.com", anonymous=None):
    requested = client.post("/api/auth/request-code", json={"email": email})
    assert requested.status_code == 200
    body = {"email": email, "code": requested.json()["developmentCode"]}
    if anonymous:
        body["guestToken"] = anonymous["accessToken"]
    response = client.post("/api/auth/verify", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def image_bytes(format="PNG", exif=None):
    output = BytesIO()
    image = Image.new("RGB", (120, 80), "green")
    image.save(output, format=format, **({"exif": exif} if exif else {}))
    return output.getvalue()


def upload(client, session, content=None, mime="image/png"):
    response = client.post("/api/analyses", files={"file": ("match.png", content or image_bytes(), mime)}, headers=headers(session))
    assert response.status_code == 202, response.text
    return response.json()


def scene(asset=None):
    timestamp = datetime.now(timezone.utc).isoformat()
    value = {"schemaVersion": 1, "id": str(uuid.uuid4()), "title": "Break the press", "revision": 0, "pitch": {"length": 105, "width": 68}, "calibration": {"status": "manual"}, "actors": [{"id": "p1", "role": "player", "team": "a", "position": {"x": 20, "y": 30}, "provenance": "manual"}], "keyframes": [{"id": "k1", "durationMs": 3000, "holdMs": 500, "positions": {"p1": {"x": 20, "y": 30}}, "annotations": []}], "createdAt": timestamp, "updatedAt": timestamp}
    if asset:
        value["source"] = {"type": "image", "url": asset["url"], "width": asset["width"], "height": asset["height"], "assetId": asset["id"], "crop": {"x": 0, "y": 0, "width": asset["width"], "height": asset["height"]}}
    return value


def save(client, session, value, revision=0):
    return client.put(f"/api/drafts/{value['id']}", json={"scene": value, "expectedRevision": revision}, headers=headers(session))


def publish(client, session, value, include=False):
    result = client.post(f"/api/drafts/{value['id']}/publish", json={"includeSource": include}, headers=headers(session))
    assert result.status_code == 201, result.text
    return result.json()


def test_authentication_required_and_no_fake_detections(client):
    assert client.post("/api/analyses", files={"file": ("match.png", image_bytes(), "image/png")}).status_code == 401
    anonymous = guest(client)
    job = upload(client, anonymous)
    assert job["status"] == "queued"
    completed = client.get(f"/api/analyses/{job['id']}", headers=headers(anonymous)).json()
    assert completed["status"] == "completed"
    assert completed["result"]["detections"] == []
    assert completed["result"]["calibration"] == {"status": "unavailable"}
    assert "not configured" in completed["result"]["notice"]
    assert client.get(f"/api/analyses/{job['id']}", headers=headers(guest(client))).status_code == 404


def test_private_upload_urls_and_orientation(client):
    exif = Image.Exif()
    exif[274] = 6
    anonymous = guest(client)
    job = upload(client, anonymous, image_bytes("JPEG", exif), "image/jpeg")
    assert (job["asset"]["width"], job["asset"]["height"]) == (80, 120)
    path = urlsplit(job["asset"]["url"])
    response = client.get(path.path + "?" + path.query)
    assert response.status_code == 200
    normalized = Image.open(BytesIO(response.content))
    assert normalized.size == (80, 120)
    assert not normalized.getexif()
    assert client.get(path.path).status_code == 404
    assert client.get(path.path + "?token=wrong").status_code == 404
    assert client.get(f"/api/assets/{job['asset']['id']}/url", headers=headers(guest(client))).status_code == 404


def test_invalid_uploads_and_expired_link(client):
    anonymous = guest(client)
    assert client.post("/api/analyses", files={"file": ("bad.png", b"not an image", "image/png")}, headers=headers(anonymous)).status_code == 415
    assert client.post("/api/analyses", files={"file": ("bad.svg", b"<svg></svg>", "image/svg+xml")}, headers=headers(anonymous)).status_code == 415
    assert client.post("/api/analyses", files={"file": ("huge.png", b"x"*(10*1024*1024+1), "image/png")}, headers=headers(anonymous)).status_code == 413
    job = upload(client, anonymous)
    token = client.app.state.store.list("asset_tokens", {"owner_id": anonymous["user"]["id"]})[0]
    token["expires_at"] = 0
    client.app.state.store.replace("asset_tokens", token)
    path = urlsplit(job["asset"]["url"])
    assert client.get(path.path+"?"+path.query).status_code == 404


def test_code_one_time_and_guest_claim_continuity(client):
    anonymous = guest(client)
    job = upload(client, anonymous)
    value = scene(job["asset"])
    assert save(client, anonymous, value).status_code == 200
    requested = client.post("/api/auth/request-code", json={"email": "coach@example.com"}).json()
    wrong_code = str((int(requested["developmentCode"])+1) % 1_000_000).zfill(6)
    assert client.post("/api/auth/verify", json={"email": "coach@example.com", "code": wrong_code}).status_code == 401
    body = {"email": "coach@example.com", "code": requested["developmentCode"], "guestToken": anonymous["accessToken"]}
    owner = client.post("/api/auth/verify", json=body).json()
    assert not owner["user"]["isAnonymous"]
    assert client.post("/api/auth/verify", json=body).status_code == 401
    assert client.get(f"/api/analyses/{job['id']}", headers=headers(owner)).status_code == 200
    assert client.get(f"/api/drafts/{value['id']}", headers=headers(owner)).status_code == 200
    assert client.get(f"/api/assets/{job['asset']['id']}/url", headers=headers(owner)).status_code == 200
    assert client.get(f"/api/drafts/{value['id']}", headers=headers(anonymous)).status_code == 404


def test_development_code_never_returned_in_test_mode(tmp_path):
    with TestClient(create_app(Settings(environment="test", data_dir=tmp_path))) as client:
        assert client.post("/api/auth/request-code", json={"email": "coach@example.com"}).json() == {"sent": True}


def test_revision_conflict_owner_isolation_and_persistence(client):
    owner = login(client)
    value = scene()
    first = save(client, owner, value)
    assert first.status_code == 200
    assert first.json()["revision"] == 1
    value["title"] = "Updated"
    assert save(client, owner, value, 0).status_code == 409
    updated = save(client, owner, value, 1)
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2
    outsider = login(client, "other@example.com")
    assert client.get(f"/api/drafts/{value['id']}", headers=headers(outsider)).status_code == 404
    assert save(client, outsider, value, 2).status_code == 404
    assert client.get("/api/drafts", headers=headers(outsider)).json() == []
    with TestClient(create_app(client.app.state.settings)) as restarted:
        assert restarted.get(f"/api/drafts/{value['id']}", headers=headers(owner)).json()["title"] == "Updated"


def test_immutable_publication_source_opt_in_and_asset_delete_controls(client):
    owner = login(client)
    job = upload(client, owner)
    value = scene(job["asset"])
    assert save(client, owner, value).status_code == 200
    private = publish(client, owner, value)
    assert re.fullmatch(r"[A-Za-z0-9_-]{12}", private["id"])
    assert "source" not in private["scene"]
    assert "source" not in client.get(f"/api/publications/{private['id']}").json()["scene"]
    opted = publish(client, owner, value, True)
    assert opted["scene"]["source"]["assetId"] == job["asset"]["id"]
    value["title"] = "A different explanation"
    assert save(client, owner, value, 1).status_code == 200
    assert client.get(f"/api/publications/{private['id']}").json()["scene"]["title"] == "Break the press"
    legacy = deepcopy(client.app.state.store.get("publications", private["id"]))
    legacy["id"] = str(uuid.uuid4())
    client.app.state.store.insert("publications", legacy)
    assert client.get(f"/api/publications/{legacy['id']}").json()["scene"]["title"] == "Break the press"
    assert client.delete(f"/api/assets/{job['asset']['id']}", headers=headers(owner)).status_code == 409
    assert client.delete(f"/api/drafts/{value['id']}", headers=headers(owner)).status_code == 204
    assert client.delete(f"/api/assets/{job['asset']['id']}", headers=headers(owner)).status_code == 409
    assert client.delete(f"/api/publications/{opted['id']}", headers=headers(owner)).status_code == 204
    assert client.delete(f"/api/assets/{job['asset']['id']}", headers=headers(owner)).status_code == 204
    assert client.get(f"/api/publications/{opted['id']}").status_code == 404


def test_comments_anchor_thread_and_owner_moderation(client):
    owner = login(client)
    outsider = login(client, "reviewer@example.com")
    value = scene()
    save(client, owner, value)
    publication = publish(client, owner, value)
    path = f"/api/publications/{publication['id']}/comments"
    body = {"body": "Why does this player hold the line?", "anchor": {"timeMs": 1000, "actorId": "p1", "point": {"x": 20, "y": 30}}}
    assert client.post(path, json=body).status_code == 401
    assert client.post(path, json=body, headers=headers(guest(client))).status_code == 403
    invalid = deepcopy(body)
    invalid["anchor"]["timeMs"] = 999999
    assert client.post(path, json=invalid, headers=headers(outsider)).status_code == 422
    invalid["anchor"] = {"timeMs": 0, "actorId": "missing"}
    assert client.post(path, json=invalid, headers=headers(outsider)).status_code == 422
    comment = client.post(path, json=body, headers=headers(outsider)).json()
    reply = client.post(path, json={**body, "body": "To keep the passing lane closed.", "parentId": comment["id"]}, headers=headers(owner))
    assert reply.status_code == 201
    assert client.post(path, json={**body, "parentId": reply.json()["id"]}, headers=headers(owner)).status_code == 422
    stranger = login(client, "stranger@example.com")
    assert client.delete(path+"/"+comment["id"], headers=headers(stranger)).status_code == 403
    assert client.delete(path+"/"+comment["id"], headers=headers(owner)).status_code == 204
    comments = client.get(path).json()
    assert len(comments) == 2
    assert comments[0]["body"] == "[Comment removed]"
    assert comments[1]["parentId"] == comment["id"]


def test_real_homography_and_degenerate_landmarks(client):
    anonymous = guest(client)
    landmarks = [{"image": {"x": x, "y": y}, "pitch": {"x": x*105, "y": y*68}} for x,y in [(0,0),(1,0),(1,1),(0,1)]]
    result = client.post("/api/calibrations", json={"landmarks": landmarks}, headers=headers(anonymous))
    assert result.status_code == 200
    h = result.json()["matrix"]
    assert math.isclose(h[0], 105, abs_tol=1e-6)
    assert math.isclose(h[4], 68, abs_tol=1e-6)
    assert result.json()["status"] == "confirmed"
    same_line = [{"image": {"x": x, "y": .5}, "pitch": {"x": x*105, "y": 30}} for x in [0,.2,.4,.8]]
    assert client.post("/api/calibrations", json={"landmarks": same_line}, headers=headers(anonymous)).status_code == 422
    assert client.post("/api/calibrations", json={"landmarks": [landmarks[0]]*4}, headers=headers(anonymous)).status_code == 422


def test_queue_caps_and_rate_limit(client):
    anonymous = guest(client)
    owner_id = anonymous["user"]["id"]
    for _ in range(2):
        client.app.state.store.reserve_analysis({"id": str(uuid.uuid4()), "owner_id": owner_id, "asset_id": "unused", "status": "queued", "created_ts": time.time()})
    response = client.post("/api/analyses", files={"file": ("match.png", image_bytes(), "image/png")}, headers=headers(anonymous))
    assert response.status_code == 429
    assert client.app.state.store.list("assets", {"owner_id": owner_id}) == []
    for _ in range(3):
        assert client.post("/api/auth/request-code", json={"email": "limited@example.com"}).status_code == 200
    assert client.post("/api/auth/request-code", json={"email": "limited@example.com"}).status_code == 429


def test_production_never_falls_back_to_sqlite(tmp_path):
    settings = Settings(environment="production", data_dir=tmp_path / "should-not-exist", public_api_url="https://api.example.com")
    with pytest.raises(RuntimeError, match="SQLite fallback is disabled"):
        create_app(settings)
    assert not settings.data_dir.exists()


def test_production_guest_cannot_save_cloud_draft(monkeypatch):
    # All remote auth/persistence calls are avoided: the save guard runs first.
    monkeypatch.setattr(Auth, "user", lambda _self, _token: {"id": "guest", "email": None, "isAnonymous": True})
    settings = Settings(environment="production", public_api_url="https://api.example.com", job_backend="modal", supabase_url="https://example.supabase.co", supabase_publishable_key="sb_publishable_test", supabase_secret_key="sb_secret_test")
    with TestClient(create_app(settings)) as remote_client:
        value = scene()
        response = remote_client.put(f"/api/drafts/{value['id']}", json={"scene": value, "expectedRevision": 0}, headers={"Authorization": "Bearer guest-token"})
        assert response.status_code == 403
        assert "Sign in with email" in response.json()["detail"]


def test_logout_revokes_local_session(client):
    owner = login(client)
    assert client.get("/api/auth/me", headers=headers(owner)).status_code == 200
    assert client.post("/api/auth/logout", headers=headers(owner)).status_code == 204
    assert client.get("/api/auth/me", headers=headers(owner)).status_code == 401

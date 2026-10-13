"""Contract tests use mocked HTTP; they do not claim a validated cloud deployment."""
import httpx
import pytest
from fastapi import HTTPException
from futvr.config import Settings
from futvr.store import Store
from futvr.auth import Auth
from futvr.storage import Storage


def production():
    return Settings(environment="production", public_api_url="https://api.example.com", supabase_url="https://example.supabase.co", supabase_anon_key="public-test-key", supabase_service_key="server-test-key")


def test_modern_api_keys_are_never_sent_as_bearer_jwts():
    settings = Settings(environment="production", public_api_url="https://api.example.com", supabase_url="https://example.supabase.co", supabase_publishable_key="sb_publishable_test", supabase_secret_key="sb_secret_test")
    settings.validate()
    store, auth = Store(settings), None
    auth = Auth(settings, store)
    storage = Storage(settings, store)
    assert store.client.headers["apikey"] == "sb_secret_test"
    assert storage.client.headers["apikey"] == "sb_secret_test"
    assert auth.client.headers["apikey"] == "sb_publishable_test"
    assert "authorization" not in store.client.headers
    assert "authorization" not in storage.client.headers
    assert "authorization" not in auth.client.headers
    store.client.close()
    storage.client.close()
    auth.client.close()


def test_supabase_auth_validates_user_remotely_and_sends_real_otp():
    settings = production()
    store, seen = Store(settings), []
    auth = Auth(settings, store)

    def server(request):
        seen.append(request)
        assert request.headers["apikey"] == "public-test-key"
        if request.url.path == "/auth/v1/user":
            if request.headers.get("authorization") != "Bearer valid-token":
                return httpx.Response(401, json={"message": "invalid JWT"})
            return httpx.Response(200, json={"id": "owner", "email": "coach@example.com", "is_anonymous": False})
        if request.url.path == "/auth/v1/otp":
            assert request.read() == b'{"email":"coach@example.com","create_user":true}'
            return httpx.Response(200, json={})
        if request.url.path == "/auth/v1/verify":
            return httpx.Response(200, json={"access_token": "valid-token", "refresh_token": "refresh-token", "user": {"id": "owner", "email": "coach@example.com", "is_anonymous": False}})
        raise AssertionError(request.url)

    auth.client.close()
    auth.client = httpx.Client(transport=httpx.MockTransport(server), headers={"apikey": settings.supabase_anon_key})
    assert auth.request_code("coach@example.com") == {"sent": True}
    with pytest.raises(HTTPException) as exc:
        auth.user("made-up-token")
    assert exc.value.status_code == 401
    assert auth.user("valid-token")["id"] == "owner"
    assert auth.verify("coach@example.com", "123456")["refreshToken"] == "refresh-token"
    auth.client.close()
    store.client.close()


def test_supabase_revision_update_has_owner_and_revision_filters():
    settings, seen = production(), []
    store = Store(settings)

    def server(request):
        seen.append(request)
        assert request.headers["apikey"] == "server-test-key"
        assert request.headers["authorization"] == "Bearer server-test-key"
        assert request.method == "PATCH"
        assert request.url.params["id"] == "eq.draft-1"
        assert request.url.params["owner_id"] == "eq.owner"
        assert request.url.params["revision"] == "eq.3"
        return httpx.Response(200, json=[])

    store.client.close()
    store.client = httpx.Client(transport=httpx.MockTransport(server), headers={"apikey": settings.supabase_service_key, "Authorization": f"Bearer {settings.supabase_service_key}"})
    assert not store.replace("drafts", {"id": "draft-1", "owner_id": "owner", "revision": 4, "scene": {}}, expected_revision=3, owner_id="owner")
    assert len(seen) == 1
    store.client.close()


def test_supabase_storage_uses_private_download_and_temporary_signing():
    settings = production()
    store = Store(settings)
    storage = Storage(settings, store)
    seen = []

    def server(request):
        seen.append(request)
        assert request.headers["authorization"] == "Bearer server-test-key"
        if request.url.path == "/storage/v1/object/sign/futvr-private/owner/asset.png":
            assert request.method == "POST"
            assert request.read() == b'{"expiresIn":900}'
            return httpx.Response(200, json={"signedURL": "/object/sign/futvr-private/owner/asset.png?token=opaque"})
        if request.url.path == "/storage/v1/object/futvr-private/owner/asset.png":
            assert request.method == "GET"
            return httpx.Response(200, content=b"private-pixels")
        raise AssertionError(request.url)

    storage.client.close()
    storage.client = httpx.Client(transport=httpx.MockTransport(server), headers={"apikey": settings.supabase_service_key, "Authorization": f"Bearer {settings.supabase_service_key}"})
    asset = {"id": "asset", "owner_id": "owner", "storage_key": "owner/asset.png"}
    signed = storage.sign(asset)
    assert signed["url"] == "https://example.supabase.co/storage/v1/object/sign/futvr-private/owner/asset.png?token=opaque"
    assert storage.read(asset) == b"private-pixels"
    assert len(seen) == 2
    storage.client.close()
    store.client.close()

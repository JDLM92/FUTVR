from datetime import datetime, timezone
import hashlib
import secrets
import uuid
import httpx
from fastapi import HTTPException
from .config import Settings
from .store import Store


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class Auth:
    def __init__(self, settings: Settings, store: Store):
        self.settings, self.store = settings, store
        if not settings.local:
            self.client = httpx.Client(timeout=20, headers={"apikey": settings.auth_api_key})

    def supabase(self, method, path, **kwargs):
        try:
            response = self.client.request(method, f"{self.settings.supabase_url}/auth/v1/{path}", **kwargs)
            if response.status_code in {400, 401, 403, 422}:
                raise HTTPException(401, "The sign-in request or code is invalid or expired")
            if response.status_code == 429:
                raise HTTPException(429, "Too many sign-in attempts; try again later")
            response.raise_for_status()
            return response.json() if response.content else {}
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(503, "Sign-in service is temporarily unavailable") from exc

    @staticmethod
    def user_view(user):
        return {"id": user["id"], "email": user.get("email") or None, "isAnonymous": bool(user.get("is_anonymous", False))}

    def local_session(self, user):
        token = secrets.token_urlsafe(48)
        self.store.insert("sessions", {"id": digest(token), "owner_id": user["id"], "expires_at": datetime.now(timezone.utc).timestamp() + self.settings.token_ttl})
        return {"accessToken": token, "user": self.user_view(user)}

    def guest(self):
        if self.settings.local:
            user = {"id": str(uuid.uuid4()), "email": None, "is_anonymous": True}
            self.store.insert("users", user)
            return self.local_session(user)
        response = self.supabase("POST", "signup", json={"data": {"application": "futvr"}})
        if not response.get("access_token") or not response.get("user", {}).get("is_anonymous"):
            raise HTTPException(503, "Anonymous Supabase sign-in must be enabled for screenshot uploads")
        return {"accessToken": response["access_token"], "refreshToken": response.get("refresh_token"), "user": self.user_view(response["user"])}

    def user(self, token):
        if not token:
            raise HTTPException(401, "Sign in to continue")
        if self.settings.local:
            session = self.store.get("sessions", digest(token))
            if not session or session["expires_at"] <= datetime.now(timezone.utc).timestamp():
                raise HTTPException(401, "Session expired; sign in again")
            user = self.store.get("users", session["owner_id"])
            if not user:
                raise HTTPException(401, "Session is no longer valid")
            return self.user_view(user)
        response = self.supabase("GET", "user", headers={"Authorization": f"Bearer {token}"})
        return self.user_view(response)

    def request_code(self, email):
        if not self.settings.local:
            self.supabase("POST", "otp", json={"email": email, "create_user": True})
            return {"sent": True}
        code = str(secrets.randbelow(1_000_000)).zfill(6)
        record = {"id": digest(email), "email": email, "code_hash": digest(email + ":" + code), "expires_at": datetime.now(timezone.utc).timestamp() + 600, "attempts": 0}
        if self.store.get("otps", record["id"]):
            self.store.replace("otps", record)
        else:
            self.store.insert("otps", record)
        result = {"sent": True}
        if self.settings.environment == "development":
            result["developmentCode"] = code
        return result

    def verify(self, email, code, guest_token=None):
        guest = self.user(guest_token) if guest_token else None
        if guest and not guest["isAnonymous"]:
            raise HTTPException(400, "Only an anonymous session can claim guest work")
        if self.settings.local:
            with self.store.lock:
                otp = self.store.get("otps", digest(email))
                if not otp or otp["expires_at"] <= datetime.now(timezone.utc).timestamp() or otp["attempts"] >= 5:
                    raise HTTPException(401, "Code is invalid or expired")
                otp["attempts"] += 1
                self.store.replace("otps", otp)
                if not secrets.compare_digest(otp["code_hash"], digest(email + ":" + code)):
                    raise HTTPException(401, "Code is invalid or expired")
                users = self.store.list("users", limit=10_000)
                user = next((u for u in users if u.get("email") == email), None)
                if not user:
                    user = {"id": str(uuid.uuid4()), "email": email, "is_anonymous": False}
                    self.store.insert("users", user)
                if guest:
                    self.store.claim_guest(guest["id"], user["id"])
                self.store.delete("otps", otp["id"])
                return self.local_session(user)
        response = self.supabase("POST", "verify", json={"email": email, "token": code, "type": "email"})
        user = self.user_view(response["user"])
        if guest:
            self.store.claim_guest(guest["id"], user["id"])
        return {"accessToken": response["access_token"], "refreshToken": response.get("refresh_token"), "user": user}

    def refresh(self, refresh_token):
        if self.settings.local:
            raise HTTPException(400, "Local sessions do not use refresh tokens")
        response = self.supabase("POST", "token?grant_type=refresh_token", json={"refresh_token": refresh_token})
        return {"accessToken": response["access_token"], "refreshToken": response.get("refresh_token"), "user": self.user_view(response["user"])}

    def logout(self, token):
        if self.settings.local:
            self.store.delete("sessions", digest(token))
        else:
            self.supabase("POST", "logout?scope=local", headers={"Authorization": f"Bearer {token}"})

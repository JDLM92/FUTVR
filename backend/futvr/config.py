from dataclasses import dataclass
from pathlib import Path
import os


@dataclass(frozen=True)
class Settings:
    environment: str = "development"
    data_dir: Path = Path(".futvr-data")
    public_api_url: str = ""
    origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")
    supabase_url: str = ""
    supabase_publishable_key: str = ""
    supabase_secret_key: str = ""
    # Legacy aliases remain supported while existing projects migrate.
    supabase_anon_key: str = ""
    supabase_service_key: str = ""
    storage_bucket: str = "futvr-private"
    rfdetr_enabled: bool = False
    job_backend: str = "local"
    max_upload_bytes: int = 10 * 1024 * 1024
    max_pixels: int = 24_000_000
    max_active_per_owner: int = 2
    max_active_global: int = 4
    asset_url_ttl: int = 900
    token_ttl: int = 60 * 60 * 24 * 7
    job_timeout_seconds: int = 300

    @property
    def local(self) -> bool:
        return self.environment in {"development", "test"}

    @property
    def auth_api_key(self) -> str:
        return self.supabase_publishable_key or self.supabase_anon_key

    @property
    def admin_api_key(self) -> str:
        return self.supabase_secret_key or self.supabase_service_key

    @property
    def admin_headers(self) -> dict[str, str]:
        # Modern API keys are not JWTs. The gateway maps the apikey to its role.
        headers = {"apikey": self.admin_api_key}
        if not self.admin_api_key.startswith("sb_"):
            headers["Authorization"] = f"Bearer {self.admin_api_key}"
        return headers

    def validate(self) -> None:
        if self.environment not in {"development", "test", "production"}:
            raise RuntimeError("FUTVR_ENV must be development, test, or production")
        if not self.local and not all((self.supabase_url, self.auth_api_key, self.admin_api_key)):
            raise RuntimeError("Production requires Supabase URL, publishable key, and server secret key (legacy aliases also supported); SQLite fallback is disabled")
        if not self.local and not self.supabase_url.startswith("https://"):
            raise RuntimeError("Production SUPABASE_URL must use HTTPS")
        if not self.local and self.public_api_url and not self.public_api_url.startswith("https://"):
            raise RuntimeError("Production FUTVR_PUBLIC_API_URL must use HTTPS")
        if self.job_backend not in {"local", "modal"}:
            raise RuntimeError("FUTVR_JOB_BACKEND must be local or modal")

    @classmethod
    def from_env(cls) -> "Settings":
        environment = os.getenv("FUTVR_ENV", "development")
        settings = cls(
            environment=environment,
            data_dir=Path(os.getenv("FUTVR_DATA_DIR", ".futvr-data")),
            public_api_url=os.getenv("FUTVR_PUBLIC_API_URL", "" if environment == "production" else "http://localhost:8000").strip().rstrip("/"),
            origins=tuple(x.strip() for x in os.getenv("FUTVR_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if x.strip()),
            supabase_url=os.getenv("SUPABASE_URL", "").rstrip("/"),
            supabase_publishable_key=os.getenv("SUPABASE_PUBLISHABLE_KEY", ""),
            supabase_secret_key=os.getenv("SUPABASE_SECRET_KEY", ""),
            supabase_anon_key=os.getenv("SUPABASE_ANON_KEY", ""),
            supabase_service_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
            storage_bucket=os.getenv("SUPABASE_STORAGE_BUCKET", "futvr-private"),
            rfdetr_enabled=os.getenv("RFDETR_ENABLED", "0") == "1",
            job_backend=os.getenv("FUTVR_JOB_BACKEND", "local"),
        )
        settings.validate()
        return settings

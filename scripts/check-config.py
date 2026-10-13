"""Report configuration presence without printing any credential value."""
import json
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except ImportError:
    pass  # Hosts can inject environment variables instead of loading a file.

keys = [
    "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY",
    "FUTVR_CORS_ORIGINS", "VITE_API_URL",
]
present = {key: bool(os.getenv(key, "").strip()) for key in keys}
present["SUPABASE_PUBLISHABLE_KEY"] |= bool(os.getenv("SUPABASE_ANON_KEY", "").strip())
present["SUPABASE_SECRET_KEY"] |= bool(os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip())
print(json.dumps({"configured": [key for key, value in present.items() if value],
                  "missing": [key for key, value in present.items() if not value]}, indent=2))

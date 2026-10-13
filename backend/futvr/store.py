"""Document persistence with compare-and-swap revisions and private owner filters."""
from pathlib import Path
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import sqlite3
import threading
import httpx
from fastapi import HTTPException
from .config import Settings

TABLES = {"assets", "asset_tokens", "analyses", "drafts", "publications", "comments", "users", "sessions", "otps"}
REMOTE_TABLES = TABLES - {"users", "sessions", "otps"}


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.lock = threading.RLock()
        if settings.local:
            settings.data_dir.mkdir(parents=True, exist_ok=True)
            self.path = settings.data_dir / "futvr.sqlite3"
            with self.connect() as conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id))")
        else:
            self.client = httpx.Client(timeout=30, headers=settings.admin_headers)

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=15)
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def check_table(self, table):
        if table not in TABLES or (not self.settings.local and table not in REMOTE_TABLES):
            raise ValueError("Unsupported table")

    def remote(self, method, table, **kwargs):
        self.check_table(table)
        try:
            result = self.client.request(method, f"{self.settings.supabase_url}/rest/v1/futvr_{table}", **kwargs)
            if result.status_code == 409:
                raise HTTPException(409, "This record was created or changed by another request")
            result.raise_for_status()
            return result.json() if result.content else None
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(503, "Persistent storage is temporarily unavailable") from exc

    @staticmethod
    def envelope(record):
        return {"id": record["id"], "owner_id": record.get("owner_id"), "revision": record.get("revision", 0), "publication_id": record.get("publication_id"), "parent_id": record.get("parent_id"), "data": record}

    def get(self, table, record_id):
        self.check_table(table)
        if self.settings.local:
            with self.connect() as conn:
                row = conn.execute("SELECT data FROM documents WHERE kind=? AND id=?", (table, record_id)).fetchone()
            return json.loads(row[0]) if row else None
        rows = self.remote("GET", table, params={"id": f"eq.{record_id}", "select": "data", "limit": "1"})
        return rows[0]["data"] if rows else None

    def list(self, table, filters=None, limit=500):
        self.check_table(table)
        filters = filters or {}
        if not set(filters).issubset({"owner_id", "publication_id", "parent_id"}):
            raise ValueError("Unsupported filter")
        if self.settings.local:
            clauses = ["kind=?"]
            args = [table]
            for key, value in filters.items():
                clauses.append(f"json_extract(data, '$.{key}') = ?")
                args.append(value)
            args.append(limit)
            with self.connect() as conn:
                rows = conn.execute(f"SELECT data FROM documents WHERE {' AND '.join(clauses)} ORDER BY rowid DESC LIMIT ?", args).fetchall()
            return [json.loads(row[0]) for row in rows]
        params = {key: f"eq.{value}" for key, value in filters.items()}
        params.update({"select": "data", "limit": str(limit), "order": "created_at.desc"})
        return [row["data"] for row in self.remote("GET", table, params=params)]

    def insert(self, table, record):
        self.check_table(table)
        if self.settings.local:
            with self.connect() as conn:
                try:
                    conn.execute("INSERT INTO documents VALUES(?,?,?)", (table, record["id"], json.dumps(record)))
                except sqlite3.IntegrityError as exc:
                    raise HTTPException(409, "This record already exists") from exc
        else:
            self.remote("POST", table, json=self.envelope(record), headers={"Prefer": "return=minimal"})
        return record

    def replace(self, table, record, expected_revision=None, owner_id=None):
        self.check_table(table)
        if self.settings.local:
            with self.connect() as conn:
                clauses = ["kind=?", "id=?"]
                args = [table, record["id"]]
                if expected_revision is not None:
                    clauses.append("json_extract(data, '$.revision') = ?")
                    args.append(expected_revision)
                if owner_id is not None:
                    clauses.append("json_extract(data, '$.owner_id') = ?")
                    args.append(owner_id)
                result = conn.execute(f"UPDATE documents SET data=? WHERE {' AND '.join(clauses)}", [json.dumps(record), *args])
                return result.rowcount == 1
        params = {"id": f"eq.{record['id']}"}
        if expected_revision is not None:
            params["revision"] = f"eq.{expected_revision}"
        if owner_id is not None:
            params["owner_id"] = f"eq.{owner_id}"
        rows = self.remote("PATCH", table, params=params, json=self.envelope(record), headers={"Prefer": "return=representation"})
        return bool(rows)

    def delete(self, table, record_id, owner_id=None):
        self.check_table(table)
        if self.settings.local:
            with self.connect() as conn:
                if owner_id is None:
                    result = conn.execute("DELETE FROM documents WHERE kind=? AND id=?", (table, record_id))
                else:
                    result = conn.execute("DELETE FROM documents WHERE kind=? AND id=? AND json_extract(data, '$.owner_id')=?", (table, record_id, owner_id))
                return result.rowcount > 0
        params = {"id": f"eq.{record_id}"}
        if owner_id is not None:
            params["owner_id"] = f"eq.{owner_id}"
        return bool(self.remote("DELETE", table, params=params, headers={"Prefer": "return=representation"}))

    def reserve_analysis(self, record):
        """Admission is atomic across workers; expired jobs do not consume slots."""
        cutoff = datetime.now(timezone.utc).timestamp() - self.settings.job_timeout_seconds
        if self.settings.local:
            with self.lock, self.connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                rows = conn.execute("SELECT data FROM documents WHERE kind='analyses'").fetchall()
                active = [json.loads(row[0]) for row in rows]
                active = [row for row in active if row["status"] in {"queued", "processing"} and row["created_ts"] > cutoff]
                owner_count = sum(row["owner_id"] == record["owner_id"] for row in active)
                if owner_count >= self.settings.max_active_per_owner or len(active) >= self.settings.max_active_global:
                    raise HTTPException(429, "Analysis queue is full; try again shortly", headers={"Retry-After": "30"})
                conn.execute("INSERT INTO documents VALUES('analyses',?,?)", (record["id"], json.dumps(record)))
            return
        try:
            response = self.client.post(f"{self.settings.supabase_url}/rest/v1/rpc/futvr_reserve_analysis", json={"record": self.envelope(record), "owner_limit": self.settings.max_active_per_owner, "global_limit": self.settings.max_active_global, "timeout_seconds": self.settings.job_timeout_seconds})
            if response.status_code == 429 or (response.status_code == 400 and "queue_full" in response.text):
                raise HTTPException(429, "Analysis queue is full; try again shortly", headers={"Retry-After": "30"})
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(503, "Analysis queue is temporarily unavailable") from exc

    def claim_guest(self, guest_id, user_id):
        if guest_id == user_id:
            return
        if self.settings.local:
            with self.lock, self.connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                rows = conn.execute("SELECT kind,id,data FROM documents WHERE kind IN ('assets','asset_tokens','analyses','drafts') AND json_extract(data, '$.owner_id')=?", (guest_id,)).fetchall()
                for kind, record_id, raw in rows:
                    record = json.loads(raw)
                    record["owner_id"] = user_id
                    conn.execute("UPDATE documents SET data=? WHERE kind=? AND id=?", (json.dumps(record), kind, record_id))
            return
        try:
            result = self.client.post(f"{self.settings.supabase_url}/rest/v1/rpc/futvr_claim_guest", json={"guest_id": guest_id, "user_id": user_id})
            result.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(503, "Could not claim guest work; please retry verification") from exc

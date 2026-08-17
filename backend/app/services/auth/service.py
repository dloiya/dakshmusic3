from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from ..store import Store
from ...config import Settings


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class AuthService:
    def __init__(self, settings: Settings, store: Store):
        self.settings = settings
        self.store = store

    async def login(self, password: str) -> str:
        if not self.settings.admin_password or not hmac.compare_digest(password, self.settings.admin_password):
            raise ValueError("Invalid credentials")
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        await self.store.db.query(
            "INSERT OR REPLACE INTO sessions(id_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?)",
            [hash_token(token), now, now + 2592000, now],
        )
        return token

    async def logout(self, token: str | None) -> None:
        if token:
            await self.store.db.query("DELETE FROM sessions WHERE id_hash=?", [hash_token(token)])

    async def authenticated(self, token: str | None, touch: bool = False) -> bool:
        if not token:
            return False
        digest = hash_token(token)
        rows = await self.store.db.query(
            "SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?",
            [digest, int(time.time())],
        )
        if rows and touch:
            await self.store.db.query("UPDATE sessions SET last_seen_at=? WHERE id_hash=?", [int(time.time()), digest])
        return bool(rows)

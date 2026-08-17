from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from ...config import Settings
from ...repositories import D1Repository


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class AuthService:
    def __init__(self, settings: Settings, db: D1Repository):
        self.settings = settings
        self.db = db

    async def login(self, password: str) -> str:
        if not self.settings.admin_password or not hmac.compare_digest(password, self.settings.admin_password):
            raise ValueError("Invalid credentials")
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        await self.db.execute("INSERT OR REPLACE INTO sessions(id_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?)", [hash_token(token), now, now + 2592000, now])
        return token

    async def logout(self, token: str | None) -> None:
        if token:
            await self.db.execute("DELETE FROM sessions WHERE id_hash=?", [hash_token(token)])

    async def authenticated(self, token: str | None, touch: bool = False) -> bool:
        if not token:
            return False
        digest = hash_token(token)
        row = await self.db.one("SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?", [digest, int(time.time())])
        if row and touch:
            await self.db.execute("UPDATE sessions SET last_seen_at=? WHERE id_hash=?", [int(time.time()), digest])
        return bool(row)

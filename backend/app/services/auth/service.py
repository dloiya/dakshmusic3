from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from ...config import Settings
from ...repositories import D1Repository


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def verify_password(password: str, expected: str, salt: str) -> bool:
    """Verify the existing PASSWORD_HASH/PASSWORD_SALT format without requiring a new secret."""
    if not password or not expected:
        return False
    candidates = [
        hashlib.sha256((password + salt).encode()).hexdigest(),
        hashlib.sha256((salt + password).encode()).hexdigest(),
        hashlib.sha256(password.encode()).hexdigest(),
    ]
    if len(expected) == 128:
        candidates.extend([
            hashlib.sha512((password + salt).encode()).hexdigest(),
            hashlib.sha512((salt + password).encode()).hexdigest(),
        ])
    # Also support a stored PBKDF2 value encoded as hex if that is how the existing secret was generated.
    if len(expected) in (64, 128):
        for iterations in (100_000, 200_000):
            digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations).hex()
            candidates.append(digest)
    return any(hmac.compare_digest(candidate, expected) for candidate in candidates)


class AuthService:
    def __init__(self, settings: Settings, db: D1Repository):
        self.settings = settings
        self.db = db

    async def login(self, password: str) -> str:
        if not verify_password(password, self.settings.password_hash, self.settings.password_salt):
            raise ValueError("Invalid credentials")
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        await self.db.execute(
            "INSERT OR REPLACE INTO sessions(id_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?)",
            [hash_token(token), now, now + 2592000, now],
        )
        return token

    async def logout(self, token: str | None) -> None:
        if token:
            await self.db.execute("DELETE FROM sessions WHERE id_hash=?", [hash_token(token)])

    async def authenticated(self, token: str | None, touch: bool = False) -> bool:
        if not token:
            return False
        digest = hash_token(token)
        row = await self.db.one(
            "SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?",
            [digest, int(time.time())],
        )
        if row and touch:
            await self.db.execute("UPDATE sessions SET last_seen_at=? WHERE id_hash=?", [int(time.time()), digest])
        return bool(row)

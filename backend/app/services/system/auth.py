import hashlib
import time
from fastapi import Cookie, Depends, HTTPException
from ...config import Settings, get_settings
from ...connectors.cloudflare.d1 import D1Client


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def require_session(daksh_session: str | None = Cookie(default=None), settings: Settings = Depends(get_settings)) -> str:
    if not daksh_session:
        raise HTTPException(401, "Authentication required")
    now = int(time.time())
    rows = await D1Client(settings).query("SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?", [token_hash(daksh_session), now])
    if not rows:
        raise HTTPException(401, "Authentication required")
    return daksh_session

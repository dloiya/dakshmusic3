from __future__ import annotations

from fastapi import Cookie, Depends, HTTPException
from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client
from ..repositories import D1Repository
from ..services.auth.service import AuthService


def get_db(settings: Settings = Depends(get_settings)) -> D1Repository:
    return D1Repository(D1Client(settings))


async def require_session(
    session: str | None = Cookie(default=None),
    settings: Settings = Depends(get_settings),
    db: D1Repository = Depends(get_db),
) -> str:
    if not await AuthService(settings, db).authenticated(session, touch=True):
        raise HTTPException(status_code=401, detail="Authentication required")
    return session or ""

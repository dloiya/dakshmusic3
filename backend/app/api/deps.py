from __future__ import annotations

from fastapi import Cookie, Depends, HTTPException
from ..config import Settings, get_settings
from ..services.store import Store
from ..services.auth.service import AuthService


def get_store(settings: Settings = Depends(get_settings)) -> Store:
    return Store(settings)


async def require_session(
    session: str | None = Cookie(default=None),
    settings: Settings = Depends(get_settings),
    store: Store = Depends(get_store),
) -> str:
    if not await AuthService(settings, store).authenticated(session, touch=True):
        raise HTTPException(status_code=401, detail="Authentication required")
    return session or ""

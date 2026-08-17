from __future__ import annotations

from fastapi import APIRouter, Cookie, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from ..config import Settings, get_settings
from ..services.auth.service import AuthService
from ..services.store import Store
from .deps import get_store

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    password: str


@router.post("/login")
async def login(body: LoginRequest, settings: Settings = Depends(get_settings), store: Store = Depends(get_store)):
    try:
        token = await AuthService(settings, store).login(body.password)
    except ValueError as exc:
        raise HTTPException(401, str(exc))
    response = JSONResponse({"ok": True})
    response.set_cookie("session", token, max_age=2592000, httponly=True, samesite="lax", secure=settings.environment == "production")
    return response


@router.post("/logout")
async def logout(session: str | None = Cookie(default=None), store: Store = Depends(get_store)):
    await AuthService(store.settings, store).logout(session)
    response = JSONResponse({"ok": True})
    response.delete_cookie("session")
    return response


@router.get("/session")
async def session_status(session: str | None = Cookie(default=None), store: Store = Depends(get_store)):
    return {"ok": True, "authenticated": await AuthService(store.settings, store).authenticated(session)}

from __future__ import annotations

from fastapi import APIRouter, Cookie, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from ..config import Settings, get_settings
from ..repositories import D1Repository
from ..services.auth.service import AuthService
from .deps import get_db

router = APIRouter(prefix="/auth", tags=["auth"])

class LoginRequest(BaseModel):
    password: str

@router.post("/login")
async def login(body: LoginRequest, settings: Settings = Depends(get_settings), db: D1Repository = Depends(get_db)):
    try:
        token = await AuthService(settings, db).login(body.password)
    except ValueError as exc:
        raise HTTPException(401, str(exc))
    response = JSONResponse({"ok": True})
    response.set_cookie("session", token, max_age=2592000, httponly=True, samesite="lax", secure=settings.environment == "production")
    return response

@router.post("/logout")
async def logout(session: str | None = Cookie(default=None), settings: Settings = Depends(get_settings), db: D1Repository = Depends(get_db)):
    await AuthService(settings, db).logout(session)
    response = JSONResponse({"ok": True})
    response.delete_cookie("session")
    return response

@router.get("/session")
async def session_status(session: str | None = Cookie(default=None), settings: Settings = Depends(get_settings), db: D1Repository = Depends(get_db)):
    return {"ok": True, "authenticated": await AuthService(settings, db).authenticated(session)}

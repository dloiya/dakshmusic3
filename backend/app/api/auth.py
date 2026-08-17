import hashlib
import hmac
import secrets
import time
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel
from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    password: str


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@router.post("/login")
async def login(body: LoginRequest, response: Response, settings: Settings = Depends(get_settings)):
    if not settings.admin_password or not hmac.compare_digest(body.password, settings.admin_password):
        raise HTTPException(401, "Invalid credentials")
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    await D1Client(settings).query("INSERT INTO sessions(id_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)", [token_hash(token), now, now + 30 * 86400, now])
    response.set_cookie("daksh_session", token, httponly=True, secure=settings.environment == "production", samesite="lax", max_age=30 * 86400)
    return {"ok": True}


@router.get("/session")
async def session(daksh_session: str | None = Cookie(default=None), settings: Settings = Depends(get_settings)):
    if not daksh_session:
        return {"ok": True, "authenticated": False}
    now = int(time.time())
    rows = await D1Client(settings).query("SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?", [token_hash(daksh_session), now])
    return {"ok": True, "authenticated": bool(rows)}


@router.post("/logout")
async def logout(response: Response, daksh_session: str | None = Cookie(default=None), settings: Settings = Depends(get_settings)):
    if daksh_session:
        await D1Client(settings).query("DELETE FROM sessions WHERE id_hash=?", [token_hash(daksh_session)])
    response.delete_cookie("daksh_session")
    return {"ok": True}

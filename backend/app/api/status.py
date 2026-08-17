from __future__ import annotations

from fastapi import APIRouter, Depends
from ..services.store import Store
from .deps import get_store, require_session

router = APIRouter(prefix="/status", tags=["status"])


@router.get("")
async def status(store: Store = Depends(get_store), _: str = Depends(require_session)):
    return await store.status()


@router.get("/health")
async def health(store: Store = Depends(get_store)):
    try:
        rows = await store.db.query("SELECT 1 AS ok")
        return {"ok": bool(rows and rows[0]["ok"] == 1), "database": True}
    except Exception as exc:
        return {"ok": False, "database": False, "error": str(exc)}

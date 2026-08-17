from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from ..config import Settings, get_settings
from ..services.search.service import SearchService

router = APIRouter(prefix="/search", tags=["search"])

@router.get("")
async def search(q: str = Query(..., min_length=1), limit: int = 25, source: str = "deezer", settings: Settings = Depends(get_settings)):
    try:
        return {"ok": True, **await SearchService(settings).search(q, limit, source)}
    except ValueError as exc:
        raise HTTPException(400, str(exc))

from fastapi import APIRouter, Depends, Query
from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client
from ..services.library.tracks import TrackService

router = APIRouter(prefix="/search", tags=["search"])


@router.get("")
async def search(q: str = Query(min_length=1), limit: int = 50, settings: Settings = Depends(get_settings)):
    items = await TrackService(D1Client(settings)).list(q=q, limit=limit)
    return {"ok": True, "query": q, "items": items}

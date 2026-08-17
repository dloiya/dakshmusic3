from fastapi import APIRouter, Depends
from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client

router = APIRouter(prefix="/cache", tags=["cache"])


@router.get("/status")
async def cache_status(settings: Settings = Depends(get_settings)):
    db = D1Client(settings)
    rows = await db.query("SELECT scope, COUNT(*) AS count FROM cache_objects GROUP BY scope ORDER BY scope")
    candidates = await db.query("SELECT COUNT(*) AS count FROM tracks WHERE cache_requested=1")
    return {"ok": True, "scopes": rows, "top_cache_candidates": candidates[0]["count"] if candidates else 0}


@router.post("/populate")
async def populate_top_cache(settings: Settings = Depends(get_settings)):
    rows = await D1Client(settings).query("SELECT id, title, artist FROM tracks WHERE cache_requested=1 AND storage_status != 'available' ORDER BY play_count DESC, id LIMIT 100")
    return {"ok": True, "candidates": rows, "count": len(rows), "automatic": False}


@router.delete("")
async def clear_cache(settings: Settings = Depends(get_settings)):
    await D1Client(settings).query("DELETE FROM cache_objects")
    return {"ok": True}

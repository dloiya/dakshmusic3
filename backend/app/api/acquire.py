from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from ..config import Settings, get_settings
from ..services.acquisition.acquire import AcquisitionService
from ..connectors.cloudflare.d1 import D1Client

router = APIRouter(prefix="/acquire", tags=["acquisition"])


class AcquireRequest(BaseModel):
    track_id: int


@router.post("")
async def acquire(body: AcquireRequest, settings: Settings = Depends(get_settings)):
    try:
        return {"ok": True, **await AcquisitionService(settings).acquire(body.track_id)}
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@router.get("")
async def acquisition_jobs(limit: int = 100, settings: Settings = Depends(get_settings)):
    limit = max(1, min(limit, 500))
    rows = await D1Client(settings).query("SELECT j.*, t.title, t.artist, t.album_name, t.artwork_url FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id ORDER BY j.created_at DESC LIMIT ?", [limit])
    return {"ok": True, "items": rows}

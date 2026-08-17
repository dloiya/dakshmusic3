from fastapi import APIRouter, Depends, HTTPException, Query
from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client
from ..services.library.tracks import TrackService

router = APIRouter(prefix="/library", tags=["library"])


def service(settings: Settings) -> TrackService:
    return TrackService(D1Client(settings))


@router.get("/tracks")
async def list_tracks(q: str | None = Query(default=None), limit: int = 100, offset: int = 0, settings: Settings = Depends(get_settings)):
    return {"ok": True, "items": await service(settings).list(q, limit, offset)}


@router.get("/tracks/{track_id}")
async def get_track(track_id: int, settings: Settings = Depends(get_settings)):
    track = await service(settings).get(track_id)
    if not track:
        raise HTTPException(404, "Track not found")
    return {"ok": True, "item": track}


@router.delete("/tracks/{track_id}")
async def delete_track(track_id: int, settings: Settings = Depends(get_settings)):
    await service(settings).delete(track_id)
    return {"ok": True}

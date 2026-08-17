from __future__ import annotations

import csv
import io
from typing import Any
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from ..connectors.cloudflare.r2 import R2Client
from ..services.library.service import LibraryService
from ..services.store import Store
from .deps import get_store, require_session

router = APIRouter(prefix="/library", tags=["library"])


@router.get("/tracks")
async def list_tracks(q: str | None = None, limit: int = 100, offset: int = 0, store: Store = Depends(get_store), _: str = Depends(require_session)):
    return {"ok": True, "items": await LibraryService(store).list_tracks(q, limit, offset)}


@router.get("/tracks/{track_id}")
async def get_track(track_id: int, store: Store = Depends(get_store), _: str = Depends(require_session)):
    item = await LibraryService(store).get_track(track_id)
    if not item:
        raise HTTPException(404, "Track not found")
    return {"ok": True, "item": item}


@router.post("/tracks")
async def create_track(payload: dict[str, Any], store: Store = Depends(get_store), _: str = Depends(require_session)):
    try:
        return {"ok": True, "id": await LibraryService(store).create_track(payload)}
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.patch("/tracks/{track_id}")
async def update_track(track_id: int, payload: dict[str, Any], store: Store = Depends(get_store), _: str = Depends(require_session)):
    try:
        return {"ok": True, "item": await LibraryService(store).update_track(track_id, payload)}
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@router.delete("/tracks/{track_id}")
async def delete_track(track_id: int, store: Store = Depends(get_store), _: str = Depends(require_session)):
    try:
        await LibraryService(store).delete_track(track_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    return {"ok": True}


@router.get("/albums")
async def list_albums(q: str | None = None, limit: int = 100, offset: int = 0, store: Store = Depends(get_store), _: str = Depends(require_session)):
    return {"ok": True, "items": await store.albums(q, limit, offset)}


@router.get("/albums/{album_id}")
async def get_album(album_id: int, store: Store = Depends(get_store), _: str = Depends(require_session)):
    rows = await store.db.query("SELECT * FROM albums WHERE id=?", [album_id])
    if not rows:
        raise HTTPException(404, "Album not found")
    tracks = await store.db.query("SELECT * FROM tracks WHERE album_id=? ORDER BY title COLLATE NOCASE", [album_id])
    return {"ok": True, "item": rows[0], "tracks": tracks}


@router.get("/export")
async def export_library(store: Store = Depends(get_store), _: str = Depends(require_session)):
    rows = await store.db.query("SELECT title,artist,album_name,source,source_id,source_url,isrc,duration_ms,artwork_url,cache_requested FROM tracks ORDER BY title COLLATE NOCASE")
    fields = ["title", "artist", "album_name", "source", "source_id", "source_url", "isrc", "duration_ms", "artwork_url", "cache_requested"]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=library.csv"})


@router.get("/playback/{track_id}")
async def playback(track_id: int, store: Store = Depends(get_store), _: str = Depends(require_session)):
    track = await store.track(track_id)
    if not track or not track.get("storage_key"):
        raise HTTPException(404, "Audio not available")
    obj = await R2Client(store.settings).get(track["storage_key"])
    if obj is None:
        raise HTTPException(404, "Audio object not found")
    await store.db.query("UPDATE tracks SET play_count=play_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", [track_id])
    body = getattr(obj, "body", None) if not isinstance(obj, dict) else obj.get("Body")
    if body is None:
        raise HTTPException(500, "R2 object has no readable body")
    return StreamingResponse(body, media_type="audio/flac", headers={"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600"})

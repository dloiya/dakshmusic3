from __future__ import annotations

import csv
import io
from typing import Any
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from ..config import Settings, get_settings
from ..connectors.cloudflare.r2 import R2Client
from ..repositories import D1Repository, LibraryRepository
from ..services.library.service import LibraryService
from .deps import get_db

router = APIRouter(prefix="/library", tags=["library"])

def get_library(db: D1Repository = Depends(get_db)) -> LibraryService:
    return LibraryService(LibraryRepository(db))

@router.get("/tracks")
async def list_tracks(q: str | None = None, limit: int = 100, offset: int = 0, service: LibraryService = Depends(get_library)):
    return {"ok": True, "items": await service.list_tracks(q, limit, offset)}

@router.get("/tracks/{track_id}")
async def get_track(track_id: int, service: LibraryService = Depends(get_library)):
    item = await service.get_track(track_id)
    if not item: raise HTTPException(404, "Track not found")
    return {"ok": True, "item": item}

@router.post("/tracks")
async def create_track(payload: dict[str, Any], service: LibraryService = Depends(get_library)):
    try: return {"ok": True, "item": await service.create_track(payload)}
    except ValueError as exc: raise HTTPException(422, str(exc))

@router.patch("/tracks/{track_id}")
async def update_track(track_id: int, payload: dict[str, Any], service: LibraryService = Depends(get_library)):
    try: return {"ok": True, "item": await service.update_track(track_id, payload)}
    except ValueError as exc: raise HTTPException(404, str(exc))

@router.delete("/tracks/{track_id}")
async def delete_track(track_id: int, service: LibraryService = Depends(get_library)):
    try: await service.delete_track(track_id)
    except ValueError as exc: raise HTTPException(404, str(exc))
    return {"ok": True}

@router.get("/albums")
async def list_albums(q: str | None = None, limit: int = 100, offset: int = 0, db: D1Repository = Depends(get_db)):
    return {"ok": True, "items": await LibraryRepository(db).albums(q, limit, offset)}

@router.get("/albums/{album_id}")
async def get_album(album_id: int, db: D1Repository = Depends(get_db)):
    album = await db.one("SELECT * FROM albums WHERE id=?", [album_id])
    if not album: raise HTTPException(404, "Album not found")
    tracks = await db.query("SELECT * FROM tracks WHERE album_id=? ORDER BY title COLLATE NOCASE", [album_id])
    return {"ok": True, "item": album, "tracks": tracks}

@router.get("/export")
async def export_library(db: D1Repository = Depends(get_db)):
    fields=["title","artist","album_name","source","source_id","source_url","isrc","duration_ms","artwork_url","cache_requested"]
    rows=await db.query("SELECT " + ",".join(fields) + " FROM tracks ORDER BY title COLLATE NOCASE")
    output=io.StringIO(); writer=csv.DictWriter(output,fieldnames=fields); writer.writeheader(); writer.writerows(rows)
    return StreamingResponse(iter([output.getvalue()]),media_type="text/csv",headers={"Content-Disposition":"attachment; filename=library.csv"})

@router.get("/playback/{track_id}")
async def playback(track_id: int, settings: Settings = Depends(get_settings), db: D1Repository = Depends(get_db)):
    track=await db.one("SELECT * FROM tracks WHERE id=?",[track_id])
    if not track or not track.get("storage_key"): raise HTTPException(404,"Audio not available")
    obj=await R2Client(settings).get(track["storage_key"])
    if obj is None: raise HTTPException(404,"Audio object not found")
    await db.execute("UPDATE tracks SET play_count=play_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",[track_id])
    body=getattr(obj,"body",None) if not isinstance(obj,dict) else obj.get("Body")
    if body is None: raise HTTPException(500,"R2 object has no readable body")
    return StreamingResponse(body,media_type="audio/flac",headers={"Accept-Ranges":"bytes","Cache-Control":"private, max-age=3600"})

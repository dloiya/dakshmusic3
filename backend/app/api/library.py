from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Depends, HTTPException
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

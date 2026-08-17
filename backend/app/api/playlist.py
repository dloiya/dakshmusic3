from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from ..services.playlist.service import PlaylistService
from ..services.store import Store
from .deps import get_store, require_session

router = APIRouter(prefix="/playlist", tags=["playlist"])


@router.get("")
async def get_playlist(store: Store = Depends(get_store), _: str = Depends(require_session)):
    return {"ok": True, "items": await PlaylistService(store).get()}


@router.post("/tracks/{track_id}")
async def add_track(track_id: int, position: int | None = None, store: Store = Depends(get_store), _: str = Depends(require_session)):
    try:
        pos = await PlaylistService(store).add(track_id, position)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    return {"ok": True, "track_id": track_id, "position": pos}


@router.delete("/{entry_id}")
async def remove_track(entry_id: int, store: Store = Depends(get_store), _: str = Depends(require_session)):
    await PlaylistService(store).remove(entry_id)
    return {"ok": True}


@router.delete("")
async def clear_playlist(store: Store = Depends(get_store), _: str = Depends(require_session)):
    await PlaylistService(store).clear()
    return {"ok": True}

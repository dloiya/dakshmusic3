from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Depends, HTTPException
from ..services.queue.service import QueueService
from ..services.store import Store
from .deps import get_store, require_session

router = APIRouter(prefix="/queue", tags=["queue"])


@router.get("")
async def get_queue(key: str = "main", store: Store = Depends(get_store), _: str = Depends(require_session)):
    return {"ok": True, **await QueueService(store).get(key)}


@router.post("/{track_id}")
async def add_queue(track_id: int, key: str = "main", position: int | None = None, store: Store = Depends(get_store), _: str = Depends(require_session)):
    try:
        pos = await QueueService(store).add(key, track_id, position)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    return {"ok": True, "queue_key": key, "track_id": track_id, "position": pos}


@router.delete("/{entry_id}")
async def remove_queue(entry_id: int, key: str = "main", store: Store = Depends(get_store), _: str = Depends(require_session)):
    await QueueService(store).remove(key, entry_id)
    return {"ok": True}


@router.delete("")
async def clear_queue(key: str = "main", store: Store = Depends(get_store), _: str = Depends(require_session)):
    await QueueService(store).clear(key)
    return {"ok": True}


@router.post("/shuffle")
async def shuffle_queue(key: str = "main", store: Store = Depends(get_store), _: str = Depends(require_session)):
    return {"ok": True, **await QueueService(store).shuffle(key)}


@router.patch("/state")
async def update_queue_state(payload: dict[str, Any], key: str = "main", store: Store = Depends(get_store), _: str = Depends(require_session)):
    return {"ok": True, **await QueueService(store).update_state(key, payload)}

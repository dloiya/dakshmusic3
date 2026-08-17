from fastapi import APIRouter, Depends
from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client

router = APIRouter(prefix="/queue", tags=["queue"])


@router.get("")
async def get_queue(queue_key: str = "main", settings: Settings = Depends(get_settings)):
    db = D1Client(settings)
    entries = await db.query("SELECT q.*, t.title, t.artist, t.album_name, t.artwork_url, t.duration_ms FROM queue_entries q JOIN tracks t ON t.id=q.track_id WHERE q.queue_key=? ORDER BY q.position", [queue_key])
    state = await db.query("SELECT * FROM queue_state WHERE queue_key=?", [queue_key])
    return {"ok": True, "queue_key": queue_key, "entries": entries, "state": state[0] if state else None}


@router.post("/{track_id}")
async def add_to_queue(track_id: int, queue_key: str = "main", settings: Settings = Depends(get_settings)):
    db = D1Client(settings)
    rows = await db.query("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM queue_entries WHERE queue_key=?", [queue_key])
    position = rows[0]["position"] if rows else 0
    await db.query("INSERT INTO queue_entries(queue_key, track_id, position) VALUES (?, ?, ?)", [queue_key, track_id, position])
    return {"ok": True, "queue_key": queue_key, "track_id": track_id, "position": position}


@router.delete("/{entry_id}")
async def remove_from_queue(entry_id: int, settings: Settings = Depends(get_settings)):
    await D1Client(settings).query("DELETE FROM queue_entries WHERE id=?", [entry_id])
    return {"ok": True}

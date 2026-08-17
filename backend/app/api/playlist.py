from fastapi import APIRouter, Depends
from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client

router = APIRouter(prefix="/playlist", tags=["playlist"])


@router.get("")
async def playlist(settings: Settings = Depends(get_settings)):
    db = D1Client(settings)
    return {"ok": True, "items": await db.query("SELECT p.id, p.position, t.* FROM playlist_entries p JOIN tracks t ON t.id=p.track_id ORDER BY p.position")}


@router.post("/tracks/{track_id}")
async def add_track(track_id: int, settings: Settings = Depends(get_settings)):
    db = D1Client(settings)
    rows = await db.query("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM playlist_entries")
    position = rows[0]["position"] if rows else 0
    await db.query("INSERT INTO playlist_entries(track_id, position) VALUES (?, ?)", [track_id, position])
    return {"ok": True, "track_id": track_id, "position": position}


@router.delete("/{entry_id}")
async def remove_entry(entry_id: int, settings: Settings = Depends(get_settings)):
    await D1Client(settings).query("DELETE FROM playlist_entries WHERE id = ?", [entry_id])
    return {"ok": True}

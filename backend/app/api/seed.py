import csv
import io
from fastapi import APIRouter, Depends, File, UploadFile
from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client

router = APIRouter(prefix="/seed", tags=["seed"])


def value(row: dict, *names: str):
    lowered = {str(k).strip().lower().replace(" ", "_"): v for k, v in row.items()}
    for name in names:
        if name in lowered and str(lowered[name] or "").strip():
            return str(lowered[name]).strip()
    return None


@router.post("")
async def seed(file: UploadFile = File(...), settings: Settings = Depends(get_settings)):
    raw = await file.read()
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
    db = D1Client(settings)
    imported = 0
    top = 0
    for row in rows:
        title = value(row, "title", "name") or "Untitled"
        artist = value(row, "artist") or "Unknown"
        album = value(row, "album", "album_name")
        source = value(row, "source", "provider")
        source_id = value(row, "source_id", "id")
        source_url = value(row, "source_url", "url")
        isrc = value(row, "isrc")
        artwork = value(row, "artwork_url", "artwork")
        duration = value(row, "duration_ms")
        cache = value(row, "100_cache", "100cache", "cache")
        await db.query("""INSERT INTO tracks(title,artist,album_name,source,source_id,source_url,isrc,artwork_url,duration_ms,cache_requested)
            VALUES(?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO NOTHING""", [title, artist, album, source, source_id, source_url, isrc, artwork, int(duration) if duration and duration.isdigit() else None, 1 if str(cache).lower() in {"1","true","yes","y"} else 0])
        imported += 1
        top += 1 if str(cache).lower() in {"1","true","yes","y"} else 0
    return {"ok": True, "rows": len(rows), "imported": imported, "top_cache_candidates": top}

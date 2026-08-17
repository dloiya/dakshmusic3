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
        source_id = value(row, "source_id")
        source_url = value(row, "source_url", "url")
        isrc = value(row, "isrc")
        artwork = value(row, "artwork_url", "artwork")
        duration = value(row, "duration_ms")
        cache = value(row, "100_cache", "100cache", "cache")
        requested = 1 if str(cache).lower() in {"1", "true", "yes", "y"} else 0
        await db.query("""INSERT INTO tracks(title,artist,album_name,source,source_id,source_url,isrc,artwork_url,duration_ms,cache_requested)
            VALUES(?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(title, artist, album_name) DO UPDATE SET
              source=COALESCE(excluded.source, tracks.source),
              source_id=COALESCE(excluded.source_id, tracks.source_id),
              source_url=COALESCE(excluded.source_url, tracks.source_url),
              isrc=COALESCE(excluded.isrc, tracks.isrc),
              artwork_url=COALESCE(excluded.artwork_url, tracks.artwork_url),
              duration_ms=COALESCE(excluded.duration_ms, tracks.duration_ms),
              cache_requested=excluded.cache_requested,
              updated_at=CURRENT_TIMESTAMP""",
            [title, artist, album, source, source_id, source_url, isrc, artwork, int(duration) if duration and duration.isdigit() else None, requested])
        imported += 1
        top += requested
    return {"ok": True, "rows": len(rows), "imported": imported, "top_cache_candidates": top}

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import secrets
import time
from typing import Any

from fastapi import APIRouter, Cookie, Depends, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from ..config import Settings, get_settings
from ..connectors.cloudflare.r2 import R2Client
from ..connectors.deezer import DeezerConnector
from ..connectors.github.actions import GitHubActionsConnector
from ..connectors.spotiflac import SpotiFlacConnector
from ..connectors.ytflac import YtFlacConnector
from ..services.store import Store

router = APIRouter(prefix="/api/v1")
ACTIVE = {"queued", "dispatched", "running"}


def store(settings: Settings = Depends(get_settings)) -> Store:
    return Store(settings)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


async def auth_session(session: str | None = Cookie(default=None), db: Store = Depends(store)):
    if not session:
        raise HTTPException(401, "Authentication required")
    rows = await db.db.query("SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?", [_hash(session), int(time.time())])
    if not rows:
        raise HTTPException(401, "Session expired")
    await db.db.query("UPDATE sessions SET last_seen_at=? WHERE id_hash=?", [int(time.time()), _hash(session)])
    return session


async def _dispatch(settings: Settings, s: Store, job_id: str, track: dict[str, Any]):
    await GitHubActionsConnector(settings).dispatch(settings.acquire_workflow, {
        "track_id": str(track["id"]),
        "job_id": job_id,
        "title": str(track.get("title") or ""),
        "artist": str(track.get("artist") or ""),
        "album": str(track.get("album_name") or ""),
        "source": str(track.get("source") or ""),
        "source_id": str(track.get("source_id") or ""),
        "source_url": str(track.get("source_url") or ""),
    })
    await s.update_job(job_id, "dispatched")


@router.get("/status")
async def status(s: Store = Depends(store), _: str = Depends(auth_session)):
    return await s.status()


@router.get("/system/health")
async def health(settings: Settings = Depends(get_settings), s: Store = Depends(store)):
    try:
        rows = await s.db.query("SELECT 1 AS ok")
        return {"ok": bool(rows and rows[0]["ok"] == 1), "service": settings.app_name, "version": "2.0.0", "database": True}
    except Exception as exc:
        return {"ok": False, "service": settings.app_name, "version": "2.0.0", "database": False, "error": str(exc)}


@router.post("/auth/login")
async def login(payload: dict[str, Any], settings: Settings = Depends(get_settings), s: Store = Depends(store)):
    if not settings.admin_password or not hmac.compare_digest(str(payload.get("password", "")), settings.admin_password):
        raise HTTPException(401, "Invalid credentials")
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    await s.db.query("INSERT OR REPLACE INTO sessions(id_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?)", [_hash(token), now, now + 2592000, now])
    response = JSONResponse({"ok": True})
    response.set_cookie("session", token, max_age=2592000, httponly=True, samesite="lax", secure=settings.environment == "production")
    return response


@router.post("/auth/logout")
async def logout(session: str | None = Cookie(default=None), s: Store = Depends(store)):
    if session:
        await s.db.query("DELETE FROM sessions WHERE id_hash=?", [_hash(session)])
    response = JSONResponse({"ok": True})
    response.delete_cookie("session")
    return response


@router.get("/auth/session")
async def session_info(session: str | None = Cookie(default=None), s: Store = Depends(store)):
    if not session:
        return {"ok": True, "authenticated": False}
    rows = await s.db.query("SELECT expires_at FROM sessions WHERE id_hash=?", [_hash(session)])
    return {"ok": True, "authenticated": bool(rows and rows[0]["expires_at"] > int(time.time()))}


@router.get("/library/tracks")
async def tracks(q: str | None = None, limit: int = 100, offset: int = 0, s: Store = Depends(store), _: str = Depends(auth_session)):
    return {"ok": True, "items": await s.tracks(q, limit, offset)}


@router.get("/library/tracks/{track_id}")
async def track(track_id: int, s: Store = Depends(store), _: str = Depends(auth_session)):
    item = await s.track(track_id)
    if not item:
        raise HTTPException(404, "Track not found")
    return {"ok": True, "item": item}


@router.post("/library/tracks")
async def create_track(payload: dict[str, Any], s: Store = Depends(store), _: str = Depends(auth_session)):
    if not payload.get("title") or not payload.get("artist"):
        raise HTTPException(422, "title and artist are required")
    return {"ok": True, "id": await s.upsert_track(payload)}


@router.patch("/library/tracks/{track_id}")
async def update_track(track_id: int, payload: dict[str, Any], s: Store = Depends(store), _: str = Depends(auth_session)):
    if not await s.track(track_id):
        raise HTTPException(404, "Track not found")
    allowed = ("title", "artist", "album_name", "source", "source_id", "source_url", "isrc", "duration_ms", "artwork_url", "storage_key", "storage_status", "play_count", "cache_requested")
    fields = [key for key in allowed if key in payload]
    if fields:
        await s.db.query(f"UPDATE tracks SET {','.join(f'{field}=?' for field in fields)},updated_at=CURRENT_TIMESTAMP WHERE id=?", [payload[field] for field in fields] + [track_id])
    return {"ok": True, "item": await s.track(track_id)}


@router.delete("/library/tracks/{track_id}")
async def delete_track(track_id: int, s: Store = Depends(store), _: str = Depends(auth_session)):
    if not await s.track(track_id):
        raise HTTPException(404, "Track not found")
    await s.delete_track(track_id)
    return {"ok": True}


@router.get("/library/albums")
async def albums(q: str | None = None, limit: int = 100, offset: int = 0, s: Store = Depends(store), _: str = Depends(auth_session)):
    return {"ok": True, "items": await s.albums(q, limit, offset)}


@router.get("/library/albums/{album_id}")
async def album(album_id: int, s: Store = Depends(store), _: str = Depends(auth_session)):
    rows = await s.db.query("SELECT * FROM albums WHERE id=?", [album_id])
    if not rows:
        raise HTTPException(404, "Album not found")
    tracks_for_album = await s.db.query("SELECT * FROM tracks WHERE album_id=? ORDER BY title COLLATE NOCASE", [album_id])
    return {"ok": True, "item": rows[0], "tracks": tracks_for_album}


@router.get("/playlist")
async def playlist(s: Store = Depends(store), _: str = Depends(auth_session)):
    return {"ok": True, "items": await s.playlist()}


@router.post("/playlist/tracks/{track_id}")
async def playlist_add(track_id: int, position: int | None = None, s: Store = Depends(store), _: str = Depends(auth_session)):
    if not await s.track(track_id):
        raise HTTPException(404, "Track not found")
    return {"ok": True, "track_id": track_id, "position": await s.playlist_add(track_id, position)}


@router.delete("/playlist/{entry_id}")
async def playlist_remove(entry_id: int, s: Store = Depends(store), _: str = Depends(auth_session)):
    await s.playlist_remove(entry_id)
    return {"ok": True}


@router.delete("/playlist")
async def playlist_clear(s: Store = Depends(store), _: str = Depends(auth_session)):
    await s.playlist_clear()
    return {"ok": True}


@router.get("/queue")
async def queue(key: str = "main", s: Store = Depends(store), _: str = Depends(auth_session)):
    return {"ok": True, **(await s.queue(key))}


@router.post("/queue/{track_id}")
async def queue_add(track_id: int, key: str = "main", position: int | None = None, s: Store = Depends(store), _: str = Depends(auth_session)):
    if not await s.track(track_id):
        raise HTTPException(404, "Track not found")
    return {"ok": True, "queue_key": key, "track_id": track_id, "position": await s.queue_add(key, track_id, position)}


@router.delete("/queue/{entry_id}")
async def queue_remove(entry_id: int, key: str = "main", s: Store = Depends(store), _: str = Depends(auth_session)):
    await s.queue_remove(key, entry_id)
    return {"ok": True}


@router.delete("/queue")
async def queue_clear(key: str = "main", s: Store = Depends(store), _: str = Depends(auth_session)):
    await s.queue_clear(key)
    return {"ok": True}


@router.post("/queue/shuffle")
async def queue_shuffle(key: str = "main", s: Store = Depends(store), _: str = Depends(auth_session)):
    await s.queue_shuffle(key)
    return {"ok": True, **(await s.queue(key))}


@router.patch("/queue/state")
async def queue_state(payload: dict[str, Any], key: str = "main", s: Store = Depends(store), _: str = Depends(auth_session)):
    await s.queue_state(key, payload)
    return {"ok": True, **(await s.queue(key))}


@router.get("/search")
async def search(q: str = Query(min_length=1), limit: int = 25, source: str = "deezer", settings: Settings = Depends(get_settings), _: str = Depends(auth_session)):
    if source == "deezer":
        items = await DeezerConnector().search(q, limit)
    elif source == "spotiflac":
        items = await SpotiFlacConnector(settings).search(q, limit)
    elif source == "ytflac":
        items = await YtFlacConnector().search(q, limit)
    else:
        raise HTTPException(400, "Unsupported search source")
    return {"ok": True, "source": source, "items": items}


@router.post("/acquire/track/{track_id}")
async def acquire_track(track_id: int, s: Store = Depends(store), settings: Settings = Depends(get_settings), _: str = Depends(auth_session)):
    track = await s.track(track_id)
    if not track:
        raise HTTPException(404, "Track not found")
    job_id, created = await s.create_job(track_id)
    if created:
        try:
            await _dispatch(settings, s, job_id, track)
        except Exception as exc:
            await s.update_job(job_id, "failed", str(exc))
            raise HTTPException(502, f"Acquire worker dispatch failed: {exc}")
    return {"ok": True, "job_id": job_id, "created": created}


@router.get("/acquire")
async def acquire_jobs(s: Store = Depends(store), _: str = Depends(auth_session)):
    return await s.status()


@router.get("/acquire/jobs/{job_id}")
async def acquire_job(job_id: str, s: Store = Depends(store), _: str = Depends(auth_session)):
    rows = await s.db.query("SELECT j.*,t.title,t.artist,t.album_name,t.artwork_url,t.duration_ms FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id WHERE j.id=?", [job_id])
    if not rows:
        raise HTTPException(404, "Acquisition job not found")
    return {"ok": True, "item": rows[0]}


@router.post("/acquire/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, s: Store = Depends(store), _: str = Depends(auth_session)):
    rows = await s.db.query("SELECT id FROM acquisition_jobs WHERE id=?", [job_id])
    if not rows:
        raise HTTPException(404, "Acquisition job not found")
    await s.update_job(job_id, "cancelled")
    return {"ok": True}


@router.post("/acquire/jobs/{job_id}/retry")
async def retry_job(job_id: str, s: Store = Depends(store), settings: Settings = Depends(get_settings), _: str = Depends(auth_session)):
    rows = await s.db.query("SELECT track_id FROM acquisition_jobs WHERE id=?", [job_id])
    if not rows:
        raise HTTPException(404, "Acquisition job not found")
    track = await s.track(rows[0]["track_id"])
    if not track:
        raise HTTPException(404, "Track not found")
    await s.update_job(job_id, "cancelled")
    new_id, _ = await s.create_job(track["id"])
    try:
        await _dispatch(settings, s, new_id, track)
    except Exception as exc:
        await s.update_job(new_id, "failed", str(exc))
        raise HTTPException(502, f"Acquire worker dispatch failed: {exc}")
    return {"ok": True, "job_id": new_id}


@router.post("/seed")
async def seed(file: UploadFile = File(...), s: Store = Depends(store), _: str = Depends(auth_session)):
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(415, "CSV file required")
    return await s.import_csv(file.filename or "library.csv", await file.read())


@router.get("/seed/{job_id}")
async def seed_status(job_id: str, s: Store = Depends(store), _: str = Depends(auth_session)):
    item = await s.import_job(job_id)
    if not item:
        raise HTTPException(404, "Import job not found")
    return {"ok": True, "item": item}


@router.get("/library/export")
async def library_export(s: Store = Depends(store), _: str = Depends(auth_session)):
    rows = await s.db.query("SELECT title,artist,album_name,source,source_id,source_url,isrc,duration_ms,artwork_url,cache_requested FROM tracks ORDER BY title COLLATE NOCASE")
    output = io.StringIO()
    fields = ["title", "artist", "album_name", "source", "source_id", "source_url", "isrc", "duration_ms", "artwork_url", "cache_requested"]
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=library.csv"})


@router.get("/cache/status")
async def cache_status(s: Store = Depends(store), _: str = Depends(auth_session)):
    return await s.cache_status()


@router.post("/cache/populate")
async def cache_populate(limit: int = 100, s: Store = Depends(store), settings: Settings = Depends(get_settings), _: str = Depends(auth_session)):
    result = await s.populate_top_cache(limit)
    dispatched = 0
    for item in result["jobs"]:
        if not item["created"]:
            continue
        track = await s.track(item["track_id"])
        if not track:
            continue
        try:
            await _dispatch(settings, s, item["job_id"], track)
            dispatched += 1
        except Exception as exc:
            await s.update_job(item["job_id"], "failed", str(exc))
    result["dispatched"] = dispatched
    return result


@router.post("/crud/clear-all")
async def clear_all(include_audio: bool = True, s: Store = Depends(store), _: str = Depends(auth_session)):
    return await s.clear_all(include_audio)


@router.post("/worker/callback")
async def worker_callback(payload: dict[str, Any], authorization: str | None = Header(default=None), settings: Settings = Depends(get_settings), s: Store = Depends(store)):
    expected = settings.worker_callback_secret
    if not expected or not authorization or not hmac.compare_digest(authorization, f"Bearer {expected}"):
        raise HTTPException(401, "Invalid worker credentials")
    job_id = payload.get("job_id")
    status_value = payload.get("status")
    if not job_id or status_value not in {"running", "complete", "failed", "cancelled"}:
        raise HTTPException(400, "Invalid worker callback")
    await s.update_job(job_id, status_value, payload.get("error"))
    if status_value == "complete" and payload.get("storage_key"):
        await s.db.query("UPDATE tracks SET storage_key=?,duration_ms=COALESCE(?,duration_ms),storage_status='available',updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT track_id FROM acquisition_jobs WHERE id=?)", [payload["storage_key"], payload.get("duration_ms"), job_id])
        await s.db.query("INSERT OR REPLACE INTO cache_objects(track_id,scope,scope_id,storage_key,status,size_bytes,last_accessed_at) SELECT track_id,'server',NULL,?,?,CURRENT_TIMESTAMP FROM acquisition_jobs WHERE id=?", [payload["storage_key"], "available", payload.get("size_bytes"), job_id])
    return {"ok": True}


@router.get("/playback/{track_id}")
async def playback(track_id: int, s: Store = Depends(store), _: str = Depends(auth_session)):
    track = await s.track(track_id)
    if not track or not track.get("storage_key"):
        raise HTTPException(404, "Audio not available")
    obj = await R2Client(s.settings).get(track["storage_key"])
    if obj is None:
        raise HTTPException(404, "Audio object not found")
    await s.db.query("UPDATE tracks SET play_count=play_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", [track_id])
    body = getattr(obj, "body", None) if not isinstance(obj, dict) else obj.get("Body")
    if body is None:
        raise HTTPException(500, "R2 object has no readable body")
    return StreamingResponse(body, media_type="audio/flac", headers={"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600"})

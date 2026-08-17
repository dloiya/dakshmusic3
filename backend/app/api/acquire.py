from __future__ import annotations

import hmac
from typing import Any
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from ..config import Settings, get_settings
from ..connectors.cloudflare.r2 import R2Client
from ..services.acquisition.acquire import AcquisitionService
from ..services.store import Store
from .deps import get_store, require_session

router = APIRouter(prefix="/acquire", tags=["acquisition"])


class AcquireRequest(BaseModel):
    track_id: int


@router.post("")
async def acquire(body: AcquireRequest, settings: Settings = Depends(get_settings), store: Store = Depends(get_store), _: str = Depends(require_session)):
    try:
        return {"ok": True, **await AcquisitionService(settings).acquire(body.track_id)}
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    except Exception as exc:
        raise HTTPException(502, f"Acquire worker dispatch failed: {exc}")


@router.get("")
async def acquisition_jobs(limit: int = 100, store: Store = Depends(get_store), _: str = Depends(require_session)):
    limit = max(1, min(limit, 500))
    rows = await store.db.query("SELECT j.*,t.title,t.artist,t.album_name,t.artwork_url,t.duration_ms,t.storage_status FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id ORDER BY j.created_at DESC LIMIT ?", [limit])
    return {"ok": True, "items": rows}


@router.get("/{job_id}")
async def acquisition_job(job_id: str, store: Store = Depends(get_store), _: str = Depends(require_session)):
    rows = await store.db.query("SELECT j.*,t.title,t.artist,t.album_name,t.artwork_url,t.duration_ms FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id WHERE j.id=?", [job_id])
    if not rows:
        raise HTTPException(404, "Acquisition job not found")
    return {"ok": True, "item": rows[0]}


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str, store: Store = Depends(get_store), _: str = Depends(require_session)):
    rows = await store.db.query("SELECT id FROM acquisition_jobs WHERE id=?", [job_id])
    if not rows:
        raise HTTPException(404, "Acquisition job not found")
    await store.update_job(job_id, "cancelled")
    return {"ok": True}


@router.post("/{job_id}/retry")
async def retry_job(job_id: str, settings: Settings = Depends(get_settings), store: Store = Depends(get_store), _: str = Depends(require_session)):
    rows = await store.db.query("SELECT track_id FROM acquisition_jobs WHERE id=?", [job_id])
    if not rows:
        raise HTTPException(404, "Acquisition job not found")
    track = await store.track(rows[0]["track_id"])
    if not track:
        raise HTTPException(404, "Track not found")
    await store.update_job(job_id, "cancelled")
    new_id, _ = await store.create_job(track["id"])
    try:
        await AcquisitionService(settings).dispatch_job(new_id, track["id"])
    except Exception as exc:
        await store.update_job(new_id, "failed", str(exc))
        raise HTTPException(502, f"Acquire worker dispatch failed: {exc}")
    return {"ok": True, "job_id": new_id}


@router.post("/callback")
async def worker_callback(payload: dict[str, Any], authorization: str | None = Header(default=None), settings: Settings = Depends(get_settings), store: Store = Depends(get_store)):
    expected = settings.worker_callback_secret
    if not expected or not authorization or not hmac.compare_digest(authorization, f"Bearer {expected}"):
        raise HTTPException(401, "Invalid worker credentials")
    job_id = payload.get("job_id")
    status = payload.get("status")
    if not job_id or status not in {"running", "complete", "failed", "cancelled"}:
        raise HTTPException(400, "Invalid worker callback")
    await store.update_job(job_id, status, payload.get("error"))
    if status == "complete" and payload.get("storage_key"):
        await store.db.query("UPDATE tracks SET storage_key=?,duration_ms=COALESCE(?,duration_ms),storage_status='available',updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT track_id FROM acquisition_jobs WHERE id=?)", [payload["storage_key"], payload.get("duration_ms"), job_id])
        await store.db.query("INSERT OR REPLACE INTO cache_objects(track_id,scope,scope_id,storage_key,status,size_bytes,last_accessed_at) SELECT track_id,'server',NULL,?,?,CURRENT_TIMESTAMP FROM acquisition_jobs WHERE id=?", [payload["storage_key"], "available", payload.get("size_bytes"), job_id])
    return {"ok": True}

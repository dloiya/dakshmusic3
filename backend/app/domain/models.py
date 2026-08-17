from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class Track(BaseModel):
    id: int
    title: str
    artist: str
    album_id: int | None = None
    album_name: str | None = None
    source: str | None = None
    source_id: str | None = None
    source_url: str | None = None
    isrc: str | None = None
    duration_ms: int | None = None
    artwork_url: str | None = None
    storage_key: str | None = None
    storage_status: str = "missing"
    play_count: int = 0
    cache_requested: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


AcquisitionStatus = Literal["queued", "dispatched", "running", "complete", "failed", "cancelled"]


class AcquisitionJob(BaseModel):
    id: str
    track_id: int
    status: AcquisitionStatus
    worker: str | None = None
    attempts: int = 0
    error: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


class StatusResponse(BaseModel):
    ok: bool = True
    active: int = 0
    queued: int = 0
    dispatched: int = 0
    running: int = 0
    jobs: list[dict] = Field(default_factory=list)

from fastapi import APIRouter, Depends

from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client
from ..domain.models import StatusResponse

router = APIRouter(tags=["status"])


@router.get("/status", response_model=StatusResponse)
async def acquisition_status(settings: Settings = Depends(get_settings)):
    db = D1Client(settings)
    rows = await db.query(
        """
        SELECT j.id AS job_id, j.track_id, t.title, t.artist, t.album_name,
               j.status, j.worker, j.attempts, j.error,
               j.created_at, j.updated_at, j.started_at, j.completed_at
        FROM acquisition_jobs j
        JOIN tracks t ON t.id = j.track_id
        WHERE j.status IN ('queued', 'dispatched', 'running')
        ORDER BY j.created_at ASC
        """
    )
    counts = {"queued": 0, "dispatched": 0, "running": 0}
    for row in rows:
        if row.get("status") in counts:
            counts[row["status"]] += 1
    return StatusResponse(
        active=len(rows),
        queued=counts["queued"],
        dispatched=counts["dispatched"],
        running=counts["running"],
        jobs=rows,
    )

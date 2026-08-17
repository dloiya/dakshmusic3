import secrets
from ...connectors.cloudflare.d1 import D1Client
from ...connectors.github.actions import GitHubActionsConnector
from ...config import Settings


class AcquisitionService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.db = D1Client(settings)
        self.github = GitHubActionsConnector(settings)

    async def dispatch_job(self, job_id: str, track_id: int) -> None:
        track = await self.db.query("SELECT * FROM tracks WHERE id=?", [track_id])
        if not track:
            raise ValueError("Track not found")
        await self.github.dispatch(self.settings.acquire_workflow, {
            "job_id": job_id,
            "track_id": str(track_id),
            "title": str(track[0].get("title") or ""),
            "artist": str(track[0].get("artist") or ""),
            "album": str(track[0].get("album_name") or ""),
            "source": str(track[0].get("source") or ""),
            "source_id": str(track[0].get("source_id") or ""),
            "source_url": str(track[0].get("source_url") or ""),
        })
        await self.db.query("UPDATE acquisition_jobs SET status='dispatched',updated_at=CURRENT_TIMESTAMP,attempts=attempts+1 WHERE id=?", [job_id])

    async def acquire(self, track_id: int) -> dict:
        track = await self.db.query("SELECT * FROM tracks WHERE id=?", [track_id])
        if not track:
            raise ValueError("Track not found")
        active = await self.db.query("SELECT id FROM acquisition_jobs WHERE track_id=? AND status IN ('queued','dispatched','running') LIMIT 1", [track_id])
        if active:
            return {"job_id": active[0]["id"], "status": "already_active"}
        job_id = secrets.token_urlsafe(16)
        await self.db.query("INSERT INTO acquisition_jobs(id, track_id, status, worker) VALUES (?, ?, 'queued', 'github-actions')", [job_id, track_id])
        try:
            await self.dispatch_job(job_id, track_id)
        except Exception as exc:
            await self.db.query("UPDATE acquisition_jobs SET status='failed', error=?, updated_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP WHERE id=?", [str(exc), job_id])
            raise
        return {"job_id": job_id, "status": "dispatched", "track_id": track_id}

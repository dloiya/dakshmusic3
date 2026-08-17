from __future__ import annotations

from ...config import Settings
from ...connectors.github.actions import GitHubActionsConnector
from ...repositories import AcquisitionRepository, LibraryRepository


class AcquisitionService:
    def __init__(self, settings: Settings, jobs: AcquisitionRepository, library: LibraryRepository):
        self.settings = settings
        self.jobs = jobs
        self.library = library
        self.github = GitHubActionsConnector(settings)

    async def dispatch_job(self, job_id: str, track_id: int) -> None:
        track = await self.library.track(track_id)
        if not track:
            raise ValueError("Track not found")
        await self.github.dispatch(self.settings.acquire_workflow, {
            "job_id": job_id,
            "track_id": str(track_id),
            "title": str(track.get("title") or ""),
            "artist": str(track.get("artist") or ""),
            "album": str(track.get("album_name") or ""),
            "source": str(track.get("source") or ""),
            "source_id": str(track.get("source_id") or ""),
            "source_url": str(track.get("source_url") or ""),
        })
        await self.jobs.update(job_id, "dispatched")

    async def acquire(self, track_id: int) -> dict:
        if not await self.library.track(track_id):
            raise ValueError("Track not found")
        job_id, created = await self.jobs.create(track_id)
        if not created:
            return {"job_id": job_id, "status": "already_active", "track_id": track_id}
        try:
            await self.dispatch_job(job_id, track_id)
        except Exception as exc:
            await self.jobs.update(job_id, "failed", str(exc))
            raise
        return {"job_id": job_id, "status": "dispatched", "track_id": track_id}

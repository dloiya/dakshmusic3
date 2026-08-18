from __future__ import annotations

from ...config import Settings
from ...repositories import AcquisitionRepository, CacheRepository
from ..acquisition.acquire import AcquisitionService


class CacheService:
    def __init__(self, cache: CacheRepository, acquisition_repo: AcquisitionRepository, acquisition: AcquisitionService, settings: Settings):
        self.cache = cache
        self.acquisition_repo = acquisition_repo
        self.acquisition = acquisition
        self.settings = settings

    async def status(self):
        return await self.cache.status()

    async def populate(self, limit=None):
        """Queue Top Cache tracks in D1 and return immediately.

        The HTTP Worker never calls GitHub's API and never dispatches one
        workflow per track. A scheduled GitHub runner drains the queued jobs
        asynchronously. This keeps the request cheap and makes repeated
        Populate clicks idempotent.
        """
        requested_limit = self.settings.top_cache_limit if limit is None else int(limit)
        requested_limit = max(1, min(requested_limit, 1000))

        candidates = await self.cache.top_candidates(requested_limit)
        if not candidates:
            return {
                "ok": True,
                "requested": 0,
                "queued": 0,
                "workflow_dispatched": False,
                "message": "No tracks marked for Top Cache are pending acquisition.",
            }

        jobs = await self.acquisition_repo.create_many(
            [int(track["id"]) for track in candidates],
            worker="github-actions",
        )

        return {
            "ok": True,
            "requested": len(candidates),
            "queued": len(jobs),
            "workflow_dispatched": False,
            "message": f"Queued {len(candidates)} Top Cache tracks. Background acquisition will process them.",
        }

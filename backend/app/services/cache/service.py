from __future__ import annotations

from ...config import Settings
from ...repositories import AcquisitionRepository, CacheRepository
from ...connectors.github.actions import GitHubActionsConnector
from ..acquisition.acquire import AcquisitionService


class CacheService:
    def __init__(self, cache: CacheRepository, acquisition_repo: AcquisitionRepository, acquisition: AcquisitionService, settings: Settings):
        self.cache = cache
        self.acquisition_repo = acquisition_repo
        self.acquisition = acquisition
        self.settings = settings
        self.github = GitHubActionsConnector(settings)

    async def status(self):
        return await self.cache.status()

    async def populate(self, limit=None):
        """Start one background GitHub job for top-cache population.

        The previous implementation synchronously dispatched one GitHub
        Actions workflow per track from the HTTP Worker. Large top-cache
        populations could therefore exhaust Worker CPU/resources. The HTTP
        request now does one dispatch only; the GitHub runner performs the
        D1 selection and individual acquisition dispatches asynchronously.
        """
        requested_limit = self.settings.top_cache_limit if limit is None else int(limit)
        requested_limit = max(1, min(requested_limit, 1000))

        candidates = await self.cache.top_candidates(requested_limit)
        if not candidates:
            return {
                "ok": True,
                "requested": 0,
                "dispatched": 0,
                "workflow_dispatched": False,
                "message": "No tracks marked for Top Cache are pending acquisition.",
            }

        await self.github.dispatch(
            self.settings.populate_cache_workflow,
            {"limit": str(requested_limit)},
        )

        return {
            "ok": True,
            "requested": len(candidates),
            "dispatched": 0,
            "workflow_dispatched": True,
            "message": f"Top Cache population started for up to {len(candidates)} tracks.",
        }

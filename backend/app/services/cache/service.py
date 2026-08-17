from __future__ import annotations

from ..store import Store
from ..acquisition.acquire import AcquisitionService
from ...config import Settings


class CacheService:
    def __init__(self, settings: Settings, store: Store):
        self.settings = settings
        self.store = store
        self.acquisition = AcquisitionService(settings)

    async def status(self):
        return await self.store.cache_status()

    async def populate(self, limit=100):
        result = await self.store.populate_top_cache(limit)
        dispatched = 0
        for item in result["jobs"]:
            if not item["created"]:
                continue
            try:
                await self.acquisition.dispatch_job(item["job_id"], item["track_id"])
                dispatched += 1
            except Exception as exc:
                await self.store.update_job(item["job_id"], "failed", str(exc))
        result["dispatched"] = dispatched
        return result

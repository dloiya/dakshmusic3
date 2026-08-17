from __future__ import annotations

from ...config import Settings
from ...repositories import AcquisitionRepository, CacheRepository
from ..acquisition.acquire import AcquisitionService


class CacheService:
    def __init__(self, settings: Settings, cache: CacheRepository, acquisition_repo: AcquisitionRepository):
        self.settings = settings
        self.cache = cache
        self.acquisition_repo = acquisition_repo
        self.acquisition = AcquisitionService(settings)

    async def status(self):
        return await self.cache.status()

    async def populate(self, limit=100):
        candidates = await self.cache.top_candidates(limit)
        jobs=[]
        dispatched=0
        for track in candidates:
            job_id, created = await self.acquisition_repo.create(track["id"])
            item={"track_id":track["id"],"job_id":job_id,"created":created}
            jobs.append(item)
            if created:
                try:
                    await self.acquisition.dispatch_job(job_id, track["id"])
                    dispatched += 1
                    await self.acquisition_repo.update(job_id,"dispatched")
                except Exception as exc:
                    await self.acquisition_repo.update(job_id,"failed",str(exc))
        return {"ok":True,"requested":len(candidates),"jobs":jobs,"dispatched":dispatched}

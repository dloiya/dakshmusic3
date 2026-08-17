from __future__ import annotations
from .d1 import D1Repository

class CacheRepository:
    def __init__(self,db:D1Repository): self.db=db
    async def status(self):
        return await self.db.query("SELECT scope,status,COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM cache_objects GROUP BY scope,status ORDER BY scope,status")
    async def top_candidates(self,limit=100):
        return await self.db.query("SELECT id,title,artist,album_name,play_count,storage_status FROM tracks WHERE cache_requested=1 AND storage_status!='available' ORDER BY play_count DESC,id LIMIT ?",[max(1,min(int(limit),1000))])

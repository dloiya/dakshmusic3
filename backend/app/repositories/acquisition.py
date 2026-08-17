from __future__ import annotations
import uuid
from .d1 import D1Repository

ACTIVE=("queued","dispatched","running")

class AcquisitionRepository:
    def __init__(self, db: D1Repository): self.db=db

    async def create(self,track_id,worker="github-actions"):
        existing=await self.db.one("SELECT id FROM acquisition_jobs WHERE track_id=? AND status IN ('queued','dispatched','running') ORDER BY created_at DESC LIMIT 1",[track_id])
        if existing:return existing["id"],False
        job_id=str(uuid.uuid4())
        await self.db.execute("UPDATE tracks SET storage_status='queued',updated_at=CURRENT_TIMESTAMP WHERE id=? AND storage_status!='available'",[track_id])
        await self.db.execute("INSERT INTO acquisition_jobs(id,track_id,status,worker,attempts) VALUES(?,?,?,?,0)",[job_id,track_id,"queued",worker])
        return job_id,True

    async def get(self,job_id):
        return await self.db.one("SELECT j.*,t.title,t.artist,t.album_name,t.artwork_url,t.duration_ms,t.storage_status FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id WHERE j.id=?",[job_id])

    async def list(self,active_only=False):
        where="WHERE j.status IN ('queued','dispatched','running')" if active_only else ""
        return await self.db.query(f"SELECT j.*,t.title,t.artist,t.album_name,t.artwork_url,t.duration_ms,t.storage_status FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id {where} ORDER BY j.created_at DESC LIMIT 500")

    async def update(self,job_id,status,error=None):
        terminal=status in ("complete","failed","cancelled")
        await self.db.execute("UPDATE acquisition_jobs SET status=?,error=?,attempts=CASE WHEN ?='dispatched' THEN attempts+1 ELSE attempts END,updated_at=CURRENT_TIMESTAMP,started_at=CASE WHEN ?='running' AND started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END,completed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE id=?",[status,error,status,status,terminal,job_id])
        if terminal:
            await self.db.execute("UPDATE tracks SET storage_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT track_id FROM acquisition_jobs WHERE id=?)",["available" if status=="complete" else ("failed" if status=="failed" else "missing"),job_id])

    async def status(self):
        jobs=await self.list(False); counts={k:0 for k in ("queued","dispatched","running","complete","failed","cancelled")}
        for job in jobs: counts[job["status"]]=counts.get(job["status"],0)+1
        return {"ok":True,"active":sum(counts[k] for k in ACTIVE),"counts":counts,"jobs":jobs}

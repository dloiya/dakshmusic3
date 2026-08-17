from __future__ import annotations

import csv
import io
import uuid
from ...config import Settings
from ...connectors.cloudflare.r2 import R2Client
from ...repositories import D1Repository, LibraryRepository


class DataService:
    def __init__(self, settings: Settings, db: D1Repository):
        self.settings=settings
        self.db=db
        self.library=LibraryRepository(db)
        self.r2=R2Client(settings)

    async def clear_all(self, include_audio=True):
        deleted=await self.r2.delete_all() if include_audio else 0
        # Delete dependents before parents to satisfy D1 foreign keys.
        for table in ("cache_objects","acquisition_jobs","queue_entries","queue_state","playlist_entries","import_jobs","tracks","albums"):
            await self.db.execute(f"DELETE FROM {table}")
        return {"ok":True,"database_cleared":True,"r2_objects_deleted":deleted}

    async def import_csv(self, filename: str, content: bytes):
        job_id=str(uuid.uuid4())
        await self.db.execute("INSERT INTO import_jobs(id,filename,status,started_at) VALUES(?,?,?,CURRENT_TIMESTAMP)",[job_id,filename,"running"])
        try:
            rows=list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
            total=len(rows); imported=failed=0
            await self.db.execute("UPDATE import_jobs SET total_rows=? WHERE id=?",[total,job_id])
            for idx,row in enumerate(rows,1):
                try:
                    norm={str(k).strip().lower().replace("_","").replace(" ",""):v for k,v in row.items()}
                    cache_value=norm.get("100cache",norm.get("cache",""))
                    raw_duration=row.get("duration_ms") or row.get("Duration_ms") or row.get("duration") or ""
                    try: duration=int(float(raw_duration)) if raw_duration else None
                    except ValueError: duration=None
                    track=await self.library.upsert_track({
                        "title":row.get("title") or row.get("Title") or row.get("name") or "Unknown",
                        "artist":row.get("artist") or row.get("Artist") or "Unknown",
                        "album_name":row.get("album") or row.get("Album"),
                        "source":row.get("source"),"source_id":row.get("source_id") or row.get("id"),
                        "source_url":row.get("source_url") or row.get("url"),"isrc":row.get("isrc") or row.get("ISRC"),
                        "duration_ms":duration,"artwork_url":row.get("artwork_url") or row.get("artwork"),
                        "cache_requested":str(cache_value).strip().lower() in {"1","true","yes","y"},
                    })
                    imported+=1
                    if not await self.db.one("SELECT id FROM playlist_entries WHERE track_id=?",[track["id"]]):
                        pos=(await self.db.one("SELECT COALESCE(MAX(position),-1)+1 AS position FROM playlist_entries"))["position"]
                        await self.db.execute("INSERT INTO playlist_entries(track_id,position) VALUES(?,?)",[track["id"],pos])
                except Exception: failed+=1
                await self.db.execute("UPDATE import_jobs SET processed_rows=?,imported_rows=?,failed_rows=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[idx,imported,failed,job_id])
            await self.db.execute("UPDATE import_jobs SET status='complete',completed_at=CURRENT_TIMESTAMP WHERE id=?",[job_id])
            return {"ok":True,"job_id":job_id,"total":total,"imported":imported,"failed":failed}
        except Exception as exc:
            await self.db.execute("UPDATE import_jobs SET status='failed',error=?,completed_at=CURRENT_TIMESTAMP WHERE id=?",[str(exc),job_id])
            raise

    async def import_job(self, job_id):
        return await self.db.one("SELECT * FROM import_jobs WHERE id=?",[job_id])

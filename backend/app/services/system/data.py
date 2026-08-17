from __future__ import annotations

import csv
import io
import uuid
from ...config import Settings
from ...connectors.cloudflare.r2 import R2Client
from ...repositories import D1Repository, LibraryRepository


class DataService:
    def __init__(self, settings: Settings, db: D1Repository):
        self.settings=settings; self.db=db; self.library=LibraryRepository(db); self.r2=R2Client(settings)

    async def clear_all(self, include_audio=True):
        deleted=await self.r2.delete_all() if include_audio else 0
        for table in ("cache_objects","acquisition_jobs","queue_entries","queue_state","playlist_entries","import_jobs","tracks","albums"):
            await self.db.execute(f"DELETE FROM {table}")
        return {"ok":True,"database_cleared":True,"r2_objects_deleted":deleted}

    async def _insert_import_rows(self, job_id, rows):
        statements=[]; valid=0; failed=0
        for row in rows:
            try:
                norm={str(k).strip().lower().replace("_","").replace(" ",""):v for k,v in row.items()}
                cache_value=norm.get("100cache",norm.get("cache",""))
                raw_duration=row.get("duration_ms") or row.get("Duration_ms") or row.get("duration") or ""
                try: duration=int(float(raw_duration)) if raw_duration else None
                except (ValueError,TypeError): duration=None
                title=(row.get("title") or row.get("Title") or row.get("name") or "Unknown").strip()
                artist=(row.get("artist") or row.get("Artist") or "Unknown").strip()
                album=row.get("album") or row.get("Album")
                statements.append(("""INSERT INTO tracks(title,artist,album_name,source,source_id,source_url,isrc,duration_ms,artwork_url,cache_requested)
VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(title,artist,album_name) DO UPDATE SET source=excluded.source,source_id=excluded.source_id,source_url=excluded.source_url,isrc=excluded.isrc,duration_ms=excluded.duration_ms,artwork_url=excluded.artwork_url,cache_requested=excluded.cache_requested,updated_at=CURRENT_TIMESTAMP""",[title,artist,album,row.get("source"),row.get("source_id") or row.get("id"),row.get("source_url") or row.get("url"),row.get("isrc") or row.get("ISRC"),duration,row.get("artwork_url") or row.get("artwork"),int(str(cache_value).strip().lower() in {"1","true","yes","y"})]))
                valid+=1
            except Exception: failed+=1
        if statements: await self.db.batch(statements)
        return valid,failed

    async def start_import(self, filename, total):
        job_id=str(uuid.uuid4())
        await self.db.execute("INSERT INTO import_jobs(id,filename,status,total_rows,started_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)",[job_id,filename,"running",total])
        return job_id

    async def import_chunk(self, job_id, rows, done=False):
        job=await self.db.one("SELECT * FROM import_jobs WHERE id=?",[job_id])
        if not job: raise ValueError("Import job not found")
        imported,failed=await self._insert_import_rows(job_id,rows)
        processed=job["processed_rows"]+len(rows)
        total_imported=job["imported_rows"]+imported
        total_failed=job["failed_rows"]+failed
        if done:
            await self.db.execute("""INSERT INTO playlist_entries(track_id,position)
SELECT t.id,COALESCE((SELECT MAX(position)+1 FROM playlist_entries),0)+ROW_NUMBER() OVER (ORDER BY t.id)-1
FROM tracks t LEFT JOIN playlist_entries p ON p.track_id=t.id WHERE p.track_id IS NULL""")
            await self.db.execute("UPDATE import_jobs SET status='complete',processed_rows=?,imported_rows=?,failed_rows=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",[processed,total_imported,total_failed,job_id])
        else:
            await self.db.execute("UPDATE import_jobs SET processed_rows=?,imported_rows=?,failed_rows=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[processed,total_imported,total_failed,job_id])
        return {"ok":True,"job_id":job_id,"processed":processed,"total":job["total_rows"],"imported":total_imported,"failed":total_failed,"complete":done}

    async def import_csv(self, filename: str, content: bytes):
        rows=list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
        job_id=await self.start_import(filename,len(rows))
        for i in range(0,len(rows),100): await self.import_chunk(job_id,rows[i:i+100],i+100>=len(rows))
        return await self.import_job(job_id)

    async def import_job(self, job_id):
        return await self.db.one("SELECT * FROM import_jobs WHERE id=?",[job_id])

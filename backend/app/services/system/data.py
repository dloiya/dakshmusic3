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
        for table in ("cache_objects","acquisition_jobs","queue_entries","queue_state","playlist_entries","import_jobs","tracks","albums"):
            await self.db.execute(f"DELETE FROM {table}")
        return {"ok":True,"database_cleared":True,"r2_objects_deleted":deleted}

    async def import_csv(self, filename: str, content: bytes):
        """Import CSV in D1 batches; never perform one RPC per CSV row."""
        job_id=str(uuid.uuid4())
        await self.db.execute("INSERT INTO import_jobs(id,filename,status,started_at) VALUES(?,?,?,CURRENT_TIMESTAMP)",[job_id,filename,"running"])
        try:
            text=content.decode("utf-8-sig")
            rows=csv.DictReader(io.StringIO(text))
            buffered=[]
            total=0
            imported=0
            failed=0

            async def flush(batch_rows):
                nonlocal imported, failed
                statements=[]
                valid=0
                for row in batch_rows:
                    try:
                        norm={str(k).strip().lower().replace("_","").replace(" ",""):v for k,v in row.items()}
                        cache_value=norm.get("100cache",norm.get("cache",""))
                        raw_duration=row.get("duration_ms") or row.get("Duration_ms") or row.get("duration") or ""
                        try: duration=int(float(raw_duration)) if raw_duration else None
                        except (ValueError,TypeError): duration=None
                        title=(row.get("title") or row.get("Title") or row.get("name") or "Unknown").strip()
                        artist=(row.get("artist") or row.get("Artist") or "Unknown").strip()
                        album=row.get("album") or row.get("Album")
                        source=row.get("source")
                        source_id=row.get("source_id") or row.get("id")
                        statements.append((
                            """INSERT INTO tracks(title,artist,album_name,source,source_id,source_url,isrc,duration_ms,artwork_url,cache_requested)
                            VALUES(?,?,?,?,?,?,?,?,?,?)
                            ON CONFLICT(title,artist,album_name) DO UPDATE SET
                              source=excluded.source,source_id=excluded.source_id,source_url=excluded.source_url,
                              isrc=excluded.isrc,duration_ms=excluded.duration_ms,artwork_url=excluded.artwork_url,
                              cache_requested=excluded.cache_requested,updated_at=CURRENT_TIMESTAMP""",
                            [title,artist,album,source,source_id,row.get("source_url") or row.get("url"),row.get("isrc") or row.get("ISRC"),duration,row.get("artwork_url") or row.get("artwork"),int(str(cache_value).strip().lower() in {"1","true","yes","y"})]
                        ))
                        valid+=1
                    except Exception:
                        failed+=1
                if statements:
                    await self.db.batch(statements)
                    imported+=valid

            for row in rows:
                buffered.append(row)
                total+=1
                if len(buffered)>=50:
                    await flush(buffered)
                    buffered.clear()
                    await self.db.execute("UPDATE import_jobs SET total_rows=?,processed_rows=?,imported_rows=?,failed_rows=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[total,total,imported,failed,job_id])
            if buffered:
                await flush(buffered)
                await self.db.execute("UPDATE import_jobs SET total_rows=?,processed_rows=?,imported_rows=?,failed_rows=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[total,total,imported,failed,job_id])

            # Preserve the legacy import contract: imported tracks appear in the main playlist.
            # Do it once after the bulk insert rather than issuing a query for every row.
            await self.db.execute("""INSERT INTO playlist_entries(track_id,position)
                SELECT t.id,
                       COALESCE((SELECT MAX(position)+1 FROM playlist_entries),0)
                       + ROW_NUMBER() OVER (ORDER BY t.id)-1
                FROM tracks t
                LEFT JOIN playlist_entries p ON p.track_id=t.id
                WHERE p.track_id IS NULL""")
            await self.db.execute("UPDATE import_jobs SET status='complete',total_rows=?,processed_rows=?,imported_rows=?,failed_rows=?,completed_at=CURRENT_TIMESTAMP WHERE id=?",[total,total,imported,failed,job_id])
            return {"ok":True,"job_id":job_id,"total":total,"imported":imported,"failed":failed}
        except Exception as exc:
            await self.db.execute("UPDATE import_jobs SET status='failed',error=?,completed_at=CURRENT_TIMESTAMP WHERE id=?",[str(exc),job_id])
            raise

    async def import_job(self, job_id):
        return await self.db.one("SELECT * FROM import_jobs WHERE id=?",[job_id])

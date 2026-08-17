from __future__ import annotations

import csv
import io
import uuid
from ...config import Settings
from ...connectors.cloudflare.r2 import R2Client
from ...repositories import D1Repository, LibraryRepository


class DataService:
    def __init__(self, settings: Settings, db: D1Repository):
        self.settings = settings; self.db = db; self.library = LibraryRepository(db); self.r2 = R2Client(settings)

    async def clear_all(self, include_audio=True):
        deleted = await self.r2.delete_all() if include_audio else 0
        for table in ("cache_objects","acquisition_jobs","queue_entries","queue_state","playlist_entries","import_jobs","tracks","albums"):
            await self.db.execute(f"DELETE FROM {table}")
        return {"ok": True, "database_cleared": True, "r2_objects_deleted": deleted}

    @staticmethod
    def _v(row, *names):
        values = {str(k).strip().lower().replace("_", "").replace(" ", ""): v for k, v in row.items()}
        for name in names:
            v = values.get(name.lower().replace("_", "").replace(" ", ""))
            if v is not None and str(v).strip(): return str(v).strip()
        return None

    @classmethod
    def _track(cls, row):
        title = cls._v(row,"title","track_title","track_name","song_title","song","name") or "Unknown"
        artist = cls._v(row,"artist","artist_name","artists","track_artist","song_artist") or "Unknown"
        album = cls._v(row,"album_name","album","album_title")
        source = cls._v(row,"source","provider","service")
        source_id = cls._v(row,"source_id","track_id","spotify_id","deezer_id","youtube_id","yt_id","id")
        raw_duration = cls._v(row,"duration_ms","duration","length_ms")
        try: duration = int(float(raw_duration)) if raw_duration else None
        except (ValueError, TypeError): duration = None
        cache = cls._v(row,"100cache","cache","top_cache") or ""
        return {
            "title": title, "artist": artist, "album": album, "source": source, "source_id": source_id,
            "source_url": cls._v(row,"source_url","url","track_url"), "isrc": cls._v(row,"isrc"),
            "duration": duration, "artwork": cls._v(row,"artwork_url","artwork","cover_url","album_art"),
            "cache": int(cache.lower() in {"1","true","yes","y"})
        }

    async def _insert_import_rows(self, job_id, rows):
        statements=[]; seen=set(); failed=0
        for row in rows:
            try:
                t=self._track(row)
                key=("id",t["source"].lower(),t["source_id"]) if t["source"] and t["source_id"] else ("text",t["title"].casefold(),t["artist"].casefold(),(t["album"] or "").casefold())
                if key in seen: continue
                seen.add(key)
                statements.append(("""INSERT INTO tracks(title,artist,album_name,source,source_id,source_url,isrc,duration_ms,artwork_url,cache_requested)
SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE (source IS NOT NULL AND source=? AND source_id IS NOT NULL AND source_id=?) OR (LOWER(TRIM(title))=LOWER(TRIM(?)) AND LOWER(TRIM(artist))=LOWER(TRIM(?)) AND LOWER(TRIM(COALESCE(album_name,'')))=LOWER(TRIM(COALESCE(?,'')))))""",[t["title"],t["artist"],t["album"],t["source"],t["source_id"],t["source_url"],t["isrc"],t["duration"],t["artwork"],t["cache"],t["source"],t["source_id"],t["title"],t["artist"],t["album"]]))
            except Exception: failed+=1
        if statements: await self.db.batch(statements)
        return len(seen), failed

    async def start_import(self, filename, total):
        job_id=str(uuid.uuid4())
        await self.db.execute("INSERT INTO import_jobs(id,filename,status,total_rows,started_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)",[job_id,filename,"running",total])
        return job_id

    async def import_chunk(self, job_id, rows, done=False):
        job=await self.db.one("SELECT * FROM import_jobs WHERE id=?",[job_id])
        if not job: raise ValueError("Import job not found")
        imported,failed=await self._insert_import_rows(job_id,rows)
        processed=job["processed_rows"]+len(rows); total_imported=job["imported_rows"]+imported; total_failed=job["failed_rows"]+failed
        if done:
            await self.db.execute("DELETE FROM playlist_entries WHERE id NOT IN (SELECT MIN(id) FROM playlist_entries GROUP BY track_id)")
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

from __future__ import annotations

import csv
import io
import random
import secrets
import time
import uuid
from typing import Any

from ..connectors.cloudflare.d1 import D1Client
from ..connectors.cloudflare.r2 import R2Client
from ..config import Settings


ACTIVE = ("queued", "dispatched", "running")


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.db = D1Client(settings)
        self.r2 = R2Client(settings)

    async def tracks(self, q=None, limit=100, offset=0):
        limit = max(1, min(int(limit), 500)); offset = max(0, int(offset))
        if q:
            p = f"%{q.strip()}%"
            return await self.db.query("SELECT * FROM tracks WHERE title LIKE ? OR artist LIKE ? OR COALESCE(album_name,'') LIKE ? ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?", [p, p, p, limit, offset])
        return await self.db.query("SELECT * FROM tracks ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?", [limit, offset])

    async def track(self, track_id):
        rows = await self.db.query("SELECT * FROM tracks WHERE id=?", [track_id]); return rows[0] if rows else None

    async def upsert_track(self, data):
        existing = None
        if data.get("source") and data.get("source_id"):
            rows = await self.db.query("SELECT id FROM tracks WHERE source=? AND source_id=?", [data["source"], data["source_id"]]); existing = rows[0]["id"] if rows else None
        if existing is None:
            rows = await self.db.query("SELECT id FROM tracks WHERE title=? AND artist=? AND COALESCE(album_name,'')=COALESCE(?, '')", [data.get("title",""), data.get("artist",""), data.get("album_name")]); existing = rows[0]["id"] if rows else None
        fields = ["title","artist","album_name","source","source_id","source_url","isrc","duration_ms","artwork_url","cache_requested"]
        vals = [data.get(k) for k in fields]
        if existing:
            sets = ",".join(f"{f}=?" for f in fields)
            await self.db.execute(f"UPDATE tracks SET {sets}, updated_at=CURRENT_TIMESTAMP WHERE id=?", vals+[existing]); return existing
        rows = await self.db.query("INSERT INTO tracks(title,artist,album_name,source,source_id,source_url,isrc,duration_ms,artwork_url,cache_requested) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id", vals)
        return rows[0]["id"]

    async def delete_track(self, track_id):
        await self.db.execute("DELETE FROM tracks WHERE id=?", [track_id])

    async def albums(self, q=None, limit=100, offset=0):
        p = f"%{q.strip()}%" if q else None
        sql = "SELECT a.*, COUNT(t.id) AS track_count FROM albums a LEFT JOIN tracks t ON t.album_id=a.id"
        params=[]
        if p: sql += " WHERE a.title LIKE ? OR a.artist LIKE ?"; params += [p,p]
        sql += " GROUP BY a.id ORDER BY a.title COLLATE NOCASE LIMIT ? OFFSET ?"; params += [max(1,min(int(limit),500)),max(0,int(offset))]
        return await self.db.query(sql, params)

    async def playlist(self):
        return await self.db.query("SELECT p.id,p.position,t.* FROM playlist_entries p JOIN tracks t ON t.id=p.track_id ORDER BY p.position")

    async def playlist_add(self, track_id, position=None):
        if position is None:
            rows=await self.db.query("SELECT COALESCE(MAX(position),-1)+1 AS position FROM playlist_entries"); position=rows[0]["position"]
        await self.db.execute("INSERT INTO playlist_entries(track_id,position) VALUES(?,?)",[track_id,position]); return position

    async def playlist_remove(self, entry_id):
        await self.db.execute("DELETE FROM playlist_entries WHERE id=?",[entry_id])
        await self.db.execute("UPDATE playlist_entries SET position=position-1 WHERE position>(SELECT COALESCE(position,0) FROM playlist_entries WHERE id=?)",[entry_id])

    async def playlist_clear(self):
        await self.db.execute("DELETE FROM playlist_entries")

    async def queue(self, key="main"):
        entries=await self.db.query("SELECT q.*,t.title,t.artist,t.album_name,t.artwork_url,t.duration_ms,t.storage_status FROM queue_entries q JOIN tracks t ON t.id=q.track_id WHERE q.queue_key=? ORDER BY q.position",[key])
        state=await self.db.query("SELECT * FROM queue_state WHERE queue_key=?",[key])
        return {"queue_key":key,"entries":entries,"state":state[0] if state else {"queue_key":key,"current_index":-1,"mode":"manual","shuffle_enabled":0}}

    async def queue_add(self, key, track_id, position=None):
        if position is None:
            rows=await self.db.query("SELECT COALESCE(MAX(position),-1)+1 AS position FROM queue_entries WHERE queue_key=?",[key]); position=rows[0]["position"]
        await self.db.execute("INSERT INTO queue_entries(queue_key,track_id,position) VALUES(?,?,?)",[key,track_id,position])
        return position

    async def queue_remove(self, key, entry_id):
        await self.db.execute("DELETE FROM queue_entries WHERE queue_key=? AND id=?",[key,entry_id])
        rows=await self.db.query("SELECT id FROM queue_entries WHERE queue_key=? ORDER BY position",[key])
        for i,row in enumerate(rows): await self.db.execute("UPDATE queue_entries SET position=? WHERE id=?",[i,row["id"]])

    async def queue_clear(self,key):
        await self.db.execute("DELETE FROM queue_entries WHERE queue_key=?",[key]); await self.db.execute("DELETE FROM queue_state WHERE queue_key=?",[key])

    async def queue_shuffle(self,key):
        rows=await self.db.query("SELECT id FROM queue_entries WHERE queue_key=? ORDER BY position",[key]); ids=[r["id"] for r in rows]; random.shuffle(ids)
        for i,eid in enumerate(ids): await self.db.execute("UPDATE queue_entries SET position=? WHERE id=?",[i,eid])
        await self.db.execute("INSERT INTO queue_state(queue_key,shuffle_enabled) VALUES(?,1) ON CONFLICT(queue_key) DO UPDATE SET shuffle_enabled=1,updated_at=CURRENT_TIMESTAMP",[key])

    async def queue_state(self,key,data):
        await self.db.execute("INSERT INTO queue_state(queue_key,current_index,mode,shuffle_enabled) VALUES(?,?,?,?,)".replace(",?,?,?,?)",[key,int(data.get("current_index",-1)),data.get("mode","manual"),int(bool(data.get("shuffle_enabled",False)))])

    async def create_job(self, track_id, worker="github-actions"):
        rows=await self.db.query("SELECT id,status FROM acquisition_jobs WHERE track_id=? AND status IN ('queued','dispatched','running') ORDER BY created_at DESC LIMIT 1",[track_id])
        if rows: return rows[0]["id"], False
        job_id=str(uuid.uuid4())
        await self.db.execute("INSERT INTO acquisition_jobs(id,track_id,status,worker,attempts) VALUES(?,?,?,?,0)",[job_id,track_id,"queued",worker]); return job_id, True

    async def update_job(self, job_id, status, error=None):
        terminal = status in ("complete","failed","cancelled")
        await self.db.execute("UPDATE acquisition_jobs SET status=?,error=?,updated_at=CURRENT_TIMESTAMP,started_at=CASE WHEN ?='running' AND started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END,completed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE id=?",[status,error,status,terminal,job_id])

    async def status(self):
        jobs=await self.db.query("SELECT j.*,t.title,t.artist,t.album_name,t.artwork_url,t.duration_ms,t.storage_status FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id ORDER BY j.created_at DESC LIMIT 200")
        counts={k:0 for k in ("queued","dispatched","running","complete","failed","cancelled")}
        for j in jobs: counts[j["status"]]=counts.get(j["status"],0)+1
        return {"ok":True,"active":sum(counts[k] for k in ACTIVE),"counts":counts,"jobs":jobs}

    async def cache_status(self):
        rows=await self.db.query("SELECT scope,status,COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM cache_objects GROUP BY scope,status ORDER BY scope,status")
        return {"ok":True,"items":rows}

    async def populate_top_cache(self, limit=100):
        rows=await self.db.query("SELECT id FROM tracks WHERE cache_requested=1 AND storage_status!='available' ORDER BY play_count DESC,id LIMIT ?",[max(1,min(int(limit),1000))])
        jobs=[]
        for row in rows:
            job,created=await self.create_job(row["id"]); jobs.append({"track_id":row["id"],"job_id":job,"created":created})
        return {"ok":True,"requested":len(rows),"jobs":jobs}

    async def clear_all(self, include_audio=True):
        # Children first: this avoids the FK failure that affected the old implementation.
        for table in ("cache_objects","acquisition_jobs","queue_entries","queue_state","playlist_entries","sessions","import_jobs","tracks","albums"):
            await self.db.execute(f"DELETE FROM {table}")
        deleted=await self.r2.delete_all() if include_audio else 0
        return {"ok":True,"database_cleared":True,"r2_objects_deleted":deleted}

    async def import_csv(self, filename, content):
        job_id=str(uuid.uuid4()); await self.db.execute("INSERT INTO import_jobs(id,filename,status) VALUES(?,?,?)",[job_id,filename,"running"])
        try:
            text=content.decode("utf-8-sig") if isinstance(content,(bytes,bytearray)) else content
            rows=list(csv.DictReader(io.StringIO(text))); total=len(rows); imported=failed=0
            await self.db.execute("UPDATE import_jobs SET total_rows=?,started_at=CURRENT_TIMESTAMP WHERE id=?",[total,job_id])
            for idx,row in enumerate(rows,1):
                try:
                    cache_value=next((row[k] for k in row if k.strip().lower().replace("_","").replace(" ","") in {"100cache","cache"}),"")
                    data={"title":row.get("title") or row.get("Title") or row.get("name") or "Unknown","artist":row.get("artist") or row.get("Artist") or "Unknown","album_name":row.get("album") or row.get("Album"),"source":row.get("source"),"source_id":row.get("source_id") or row.get("id"),"source_url":row.get("source_url") or row.get("url"),"isrc":row.get("isrc") or row.get("ISRC"),"duration_ms":int(float(row.get("duration_ms") or 0)) or None,"artwork_url":row.get("artwork_url") or row.get("artwork"),"cache_requested":1 if str(cache_value).strip().lower() in {"1","true","yes","y"} else 0}
                    await self.upsert_track(data); imported+=1
                except Exception: failed+=1
                await self.db.execute("UPDATE import_jobs SET processed_rows=?,imported_rows=?,failed_rows=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[idx,imported,failed,job_id])
            await self.db.execute("UPDATE import_jobs SET status='complete',completed_at=CURRENT_TIMESTAMP WHERE id=?",[job_id])
            return {"ok":True,"job_id":job_id,"total":total,"imported":imported,"failed":failed}
        except Exception as exc:
            await self.db.execute("UPDATE import_jobs SET status='failed',error=?,completed_at=CURRENT_TIMESTAMP WHERE id=?",[str(exc),job_id]); raise

    async def import_job(self, job_id):
        rows=await self.db.query("SELECT * FROM import_jobs WHERE id=?",[job_id]); return rows[0] if rows else None

from __future__ import annotations

import random
from .d1 import D1Repository


class QueueRepository:
    def __init__(self, db: D1Repository): self.db = db

    async def get(self,key="main"):
        entries=await self.db.query("SELECT q.*,t.title,t.artist,t.album_name,t.artwork_url,t.duration_ms,t.storage_status FROM queue_entries q JOIN tracks t ON t.id=q.track_id WHERE q.queue_key=? ORDER BY q.position",[key])
        state=await self.db.one("SELECT * FROM queue_state WHERE queue_key=?",[key])
        return {"queue_key":key,"entries":entries,"state":state or {"queue_key":key,"current_index":-1,"mode":"manual","shuffle_enabled":0}}

    async def add(self,key,track_id,position=None):
        existing=await self.db.one("SELECT position FROM queue_entries WHERE queue_key=? AND track_id=?",[key,track_id])
        if existing:return existing["position"]
        if position is None:position=(await self.db.one("SELECT COALESCE(MAX(position),-1)+1 AS position FROM queue_entries WHERE queue_key=?",[key]))["position"]
        else:await self.db.execute("UPDATE queue_entries SET position=position+1 WHERE queue_key=? AND position>=?",[key,position])
        await self.db.execute("INSERT INTO queue_entries(queue_key,track_id,position) VALUES(?,?,?)",[key,track_id,position]); return position

    async def remove(self,key,entry_id):
        await self.db.execute("DELETE FROM queue_entries WHERE queue_key=? AND id=?",[key,entry_id])
        rows=await self.db.query("SELECT id FROM queue_entries WHERE queue_key=? ORDER BY position",[key])
        for i,row in enumerate(rows):await self.db.execute("UPDATE queue_entries SET position=? WHERE id=?",[i,row["id"]])

    async def clear(self,key):
        await self.db.execute("DELETE FROM queue_entries WHERE queue_key=?",[key]); await self.db.execute("DELETE FROM queue_state WHERE queue_key=?",[key])

    async def shuffle(self,key):
        rows=await self.db.query("SELECT id FROM queue_entries WHERE queue_key=? ORDER BY position",[key]); ids=[r["id"] for r in rows]; random.shuffle(ids)
        for i,eid in enumerate(ids):await self.db.execute("UPDATE queue_entries SET position=? WHERE id=?",[i,eid])
        await self.db.execute("INSERT INTO queue_state(queue_key,shuffle_enabled) VALUES(?,1) ON CONFLICT(queue_key) DO UPDATE SET shuffle_enabled=1,updated_at=CURRENT_TIMESTAMP",[key])

    async def state(self,key,data):
        await self.db.execute("INSERT INTO queue_state(queue_key,current_index,mode,shuffle_enabled) VALUES(?,?,?,?) ON CONFLICT(queue_key) DO UPDATE SET current_index=excluded.current_index,mode=excluded.mode,shuffle_enabled=excluded.shuffle_enabled,updated_at=CURRENT_TIMESTAMP",[key,int(data.get("current_index",-1)),data.get("mode","manual"),int(bool(data.get("shuffle_enabled",False)))])

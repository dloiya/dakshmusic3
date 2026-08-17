from __future__ import annotations

from .d1 import D1Repository


class PlaylistRepository:
    def __init__(self, db: D1Repository): self.db = db

    async def list(self):
        return await self.db.query("SELECT p.id,p.position,t.* FROM playlist_entries p JOIN tracks t ON t.id=p.track_id ORDER BY p.position")

    async def add(self, track_id, position=None):
        existing=await self.db.one("SELECT position FROM playlist_entries WHERE track_id=?",[track_id])
        if existing:return existing["position"]
        if position is None: position=(await self.db.one("SELECT COALESCE(MAX(position),-1)+1 AS position FROM playlist_entries"))["position"]
        else: await self.db.execute("UPDATE playlist_entries SET position=position+1 WHERE position>=?",[position])
        await self.db.execute("INSERT INTO playlist_entries(track_id,position) VALUES(?,?)",[track_id,position]); return position

    async def remove(self, entry_id):
        row=await self.db.one("SELECT position FROM playlist_entries WHERE id=?",[entry_id])
        if not row:return
        await self.db.execute("DELETE FROM playlist_entries WHERE id=?",[entry_id]); await self.db.execute("UPDATE playlist_entries SET position=position-1 WHERE position>?",[row["position"]])

    async def clear(self): await self.db.execute("DELETE FROM playlist_entries")

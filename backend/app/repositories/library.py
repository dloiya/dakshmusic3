from __future__ import annotations

from .d1 import D1Repository


class LibraryRepository:
    def __init__(self, db: D1Repository):
        self.db = db

    async def tracks(self, q=None, limit=100, offset=0):
        limit = max(1, min(int(limit), 500)); offset = max(0, int(offset))
        if q and q.strip():
            p = f"%{q.strip()}%"
            return await self.db.query("SELECT * FROM tracks WHERE title LIKE ? OR artist LIKE ? OR COALESCE(album_name,'') LIKE ? ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?", [p,p,p,limit,offset])
        return await self.db.query("SELECT * FROM tracks ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?", [limit,offset])

    async def track(self, track_id):
        return await self.db.one("SELECT * FROM tracks WHERE id=?", [track_id])

    async def delete_track(self, track_id):
        await self.db.execute("DELETE FROM tracks WHERE id=?", [track_id])

    async def albums(self, q=None, limit=100, offset=0):
        limit=max(1,min(int(limit),500)); offset=max(0,int(offset))
        params=[]; sql="SELECT a.*,COUNT(t.id) AS track_count FROM albums a LEFT JOIN tracks t ON t.album_id=a.id"
        if q and q.strip():
            p=f"%{q.strip()}%"; sql += " WHERE a.title LIKE ? OR a.artist LIKE ?"; params += [p,p]
        sql += " GROUP BY a.id ORDER BY a.title COLLATE NOCASE LIMIT ? OFFSET ?"; params += [limit,offset]
        return await self.db.query(sql, params)

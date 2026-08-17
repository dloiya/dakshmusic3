from ...connectors.cloudflare.d1 import D1Client


class TrackService:
    def __init__(self, db: D1Client):
        self.db = db

    async def list(self, q: str | None = None, limit: int = 100, offset: int = 0):
        limit = max(1, min(limit, 500))
        if q:
            pattern = f"%{q.strip()}%"
            return await self.db.query(
                """SELECT * FROM tracks
                   WHERE title LIKE ? OR artist LIKE ? OR COALESCE(album_name,'') LIKE ?
                   ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?""",
                [pattern, pattern, pattern, limit, offset],
            )
        return await self.db.query(
            "SELECT * FROM tracks ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?",
            [limit, offset],
        )

    async def get(self, track_id: int):
        rows = await self.db.query("SELECT * FROM tracks WHERE id = ?", [track_id])
        return rows[0] if rows else None

    async def delete(self, track_id: int):
        await self.db.query("DELETE FROM tracks WHERE id = ?", [track_id])

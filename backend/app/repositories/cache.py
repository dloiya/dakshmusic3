from __future__ import annotations

from .d1 import D1Repository


class CacheRepository:
    def __init__(self, db: D1Repository):
        self.db = db

    async def status(self):
        return await self.db.query(
            """
            SELECT scope,status,COUNT(*) AS count,
                   COALESCE(SUM(size_bytes),0) AS bytes
            FROM cache_objects
            GROUP BY scope,status
            ORDER BY scope,status
            """
        )

    async def top_candidates(self, limit=100):
        """Return tracks explicitly marked for Top Cache that still need audio.

        `cache_requested` is authoritative. For libraries imported from the
        enriched CSV, also recognize the legacy 100 Cache value retained in
        metadata_json so an import cannot silently turn Top Cache off.
        """
        limit = max(1, min(int(limit), 1000))
        return await self.db.query(
            """
            SELECT
                t.id,
                t.title,
                t.artist,
                t.album_name,
                t.play_count,
                t.source,
                t.source_id,
                t.source_url,
                t.storage_status
            FROM tracks t
            WHERE (
                t.cache_requested = 1
                OR lower(COALESCE(json_extract(t.metadata_json, '$."100 Cache"'), ''))
                   IN ('1','true','yes','y')
            )
            AND t.storage_status != 'available'
            AND NOT EXISTS (
                SELECT 1
                FROM acquisition_jobs j
                WHERE j.track_id = t.id
                  AND j.status IN ('queued','dispatched','running')
            )
            AND NOT EXISTS (
                SELECT 1
                FROM cache_objects c
                WHERE c.track_id = t.id
                  AND c.scope = 'top'
                  AND c.status IN ('queued','available')
            )
            ORDER BY t.play_count DESC, t.id
            LIMIT ?
            """,
            [limit],
        )

    async def mark_top_requested(self, track_ids: list[int]):
        """Backfill cache_requested for tracks selected by the CSV metadata."""
        if not track_ids:
            return
        statements = [
            (
                "UPDATE tracks SET cache_requested=1, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                [int(track_id)],
            )
            for track_id in track_ids
        ]
        await self.db.batch(statements)

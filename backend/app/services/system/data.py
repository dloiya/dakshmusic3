from __future__ import annotations

import csv
import io
import json
import uuid
from typing import Any

from ...config import Settings
from ...connectors.cloudflare.r2 import R2Client
from ...repositories import D1Repository, LibraryRepository


class DataService:
    # Larger chunks reduce per-request Worker overhead. Keep the DB work in a
    # single batch so we do not create hundreds of tiny Worker invocations.
    SEED_CHUNK_SIZE = 25
    METADATA_CHUNK_SIZE = 25

    METADATA_COLUMNS = (
        "Deezer Found", "Deezer Match Type", "Deezer Track ID", "Deezer Track Name",
        "Deezer Artist", "Deezer Artist ID", "Deezer Track Album", "Deezer Track Album ID",
        "Deezer Duration (sec)", "Deezer Preview", "Deezer URL", "Deezer BPM",
        "Deezer Release Date", "Deezer ISRC", "Deezer Explicit", "Deezer Rank",
        "Deezer Readable", "Deezer Track Link", "Artwork Source", "Artwork Album",
        "Artwork Album ID", "Artwork Artist", "Artwork Match Score", "Artwork Match Reasons",
        "Artwork", "Artwork Large", "Artwork URL", "Artwork Genre", "Artwork Release Date",
    )

    def __init__(self, settings: Settings, db: D1Repository):
        self.settings = settings
        self.db = db
        self.library = LibraryRepository(db)
        self.r2 = R2Client(settings)

    async def clear_all(self, include_audio=True):
        deleted = await self.r2.delete_all() if include_audio else 0
        for table in ("cache_objects", "acquisition_jobs", "queue_entries", "queue_state", "playlist_entries", "import_jobs", "tracks", "albums"):
            await self.db.execute(f"DELETE FROM {table}")
        return {"ok": True, "database_cleared": True, "r2_objects_deleted": deleted}

    @staticmethod
    def _v(row, *names):
        values = {str(k).strip().lower().replace("_", "").replace(" ", ""): v for k, v in row.items()}
        for name in names:
            v = values.get(name.lower().replace("_", "").replace(" ", ""))
            if v is not None and str(v).strip():
                return str(v).strip()
        return None

    @staticmethod
    def _int(value):
        if value is None or str(value).strip() == "":
            return None
        try:
            return int(float(str(value).strip()))
        except (TypeError, ValueError):
            return None

    @classmethod
    def _metadata(cls, row: dict[str, Any]) -> dict[str, Any]:
        metadata: dict[str, Any] = {}
        for column in cls.METADATA_COLUMNS:
            value = cls._v(row, column)
            if value is not None:
                metadata[column] = value

        duration_ms = cls._v(row, "duration_ms")
        if duration_ms is not None:
            metadata["duration_ms"] = cls._int(duration_ms)

        for key, value in row.items():
            normalized = str(key).strip()
            if normalized.startswith(("Deezer ", "Artwork")) and normalized not in metadata:
                if value is not None and str(value).strip():
                    metadata[normalized] = str(value).strip()
        return metadata

    @classmethod
    def _artwork_url(cls, metadata):
        for key in ("Artwork Large", "Artwork", "Artwork URL"):
            value = metadata.get(key)
            if value and str(value).strip():
                return str(value).strip()
        return None

    @classmethod
    def _track(cls, row):
        title = cls._v(row, "track_name", "track title", "trackname", "title", "song title", "name") or "Unknown"
        artist = cls._v(row, "artist_name", "artist name", "artist", "artists", "track artist") or "Unknown"
        album = cls._v(row, "album", "album_name", "album_title")
        isrc = cls._v(row, "isrc")
        apple_id = cls._v(row, "apple_id", "apple id", "apple - id")
        playlist = cls._v(row, "playlist_name", "playlist")
        track_type = cls._v(row, "type")
        cache = cls._v(row, "100cache", "100 cache", "cache", "top cache") or ""
        metadata = cls._metadata(row)
        duration_ms = cls._int(cls._v(row, "duration_ms"))
        if duration_ms is None:
            duration_ms = cls._int(metadata.get("duration_ms"))

        deezer_track_id = cls._v(row, "Deezer Track ID")
        deezer_url = cls._v(row, "Deezer URL", "Deezer Track Link")
        artwork_url = cls._artwork_url(metadata)
        source = "deezer" if deezer_track_id else ("apple" if cls._v(row, "Artwork Source") == "APPLE" else None)
        source_id = deezer_track_id or apple_id
        source_url = deezer_url or cls._v(row, "Artwork URL")

        return {
            "title": title, "artist": artist, "album": album, "isrc": isrc,
            "apple_id": apple_id, "playlist": playlist, "type": track_type,
            "cache": int(cache.lower() in {"1", "true", "yes", "y"}),
            "duration_ms": duration_ms, "artwork_url": artwork_url,
            "source": source, "source_id": source_id, "source_url": source_url,
            "metadata_json": json.dumps(metadata, ensure_ascii=False, separators=(",", ":")) if metadata else None,
        }

    async def enrich_metadata_chunk(self, rows):
        if not rows or len(rows) > self.METADATA_CHUNK_SIZE:
            raise ValueError(f"metadata chunk must contain 1-{self.METADATA_CHUNK_SIZE} rows")

        statements = []
        enriched = 0
        for row in rows:
            track = self._track(row)
            if not track.get("metadata_json") and track.get("duration_ms") is None and not track.get("artwork_url"):
                continue

            if track.get("isrc"):
                where = "isrc=?"
                identity = [track["isrc"]]
            else:
                where = "title=? AND artist=? AND COALESCE(album_name,'')=COALESCE(?, '')"
                identity = [track["title"], track["artist"], track.get("album")]

            statements.append((
                f"""UPDATE tracks SET duration_ms=COALESCE(?,duration_ms), artwork_url=COALESCE(?,artwork_url), source=COALESCE(?,source), source_id=COALESCE(?,source_id), source_url=COALESCE(?,source_url), album_name=COALESCE(NULLIF(?,''),album_name), metadata_json=COALESCE(?,metadata_json), updated_at=CURRENT_TIMESTAMP WHERE {where}""",
                [track.get("duration_ms"), track.get("artwork_url"), track.get("source"), track.get("source_id"), track.get("source_url"), track.get("album"), track.get("metadata_json"), *identity],
            ))
            enriched += 1

        if statements:
            await self.db.batch(statements)
        return {"processed": len(rows), "enriched": enriched}

    async def _insert_import_rows(self, job_id, rows):
        tracks = []
        seen = set()
        failed = 0
        for row in rows:
            try:
                track = self._track(row)
                key = (("isrc", track["isrc"].casefold()) if track["isrc"] else ("text", track["title"].casefold(), track["artist"].casefold(), (track["album"] or "").casefold()))
                if key not in seen:
                    seen.add(key)
                    tracks.append(track)
            except Exception:
                failed += 1

        statements = []
        for track in tracks:
            values = [track["title"], track["artist"], track["album"], track["isrc"], track["duration_ms"], track["artwork_url"], track["source"], track["source_id"], track["source_url"], track["metadata_json"], track["cache"]]

            if track.get("isrc"):
                statements.append((
                    """UPDATE tracks SET title=?,artist=?,album_name=?,isrc=COALESCE(?,isrc),duration_ms=COALESCE(?,duration_ms),artwork_url=COALESCE(?,artwork_url),source=COALESCE(?,source),source_id=COALESCE(?,source_id),source_url=COALESCE(?,source_url),metadata_json=COALESCE(?,metadata_json),cache_requested=MAX(cache_requested,?),updated_at=CURRENT_TIMESTAMP WHERE isrc=?""",
                    values + [track["isrc"]],
                ))
                statements.append((
                    """INSERT INTO tracks(title,artist,album_name,isrc,duration_ms,artwork_url,source,source_id,source_url,metadata_json,cache_requested) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE isrc=?)""",
                    values + [track["isrc"]],
                ))
            else:
                statements.append((
                    """INSERT INTO tracks(title,artist,album_name,isrc,duration_ms,artwork_url,source,source_id,source_url,metadata_json,cache_requested) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(title,artist,album_name) DO UPDATE SET duration_ms=COALESCE(excluded.duration_ms,tracks.duration_ms),artwork_url=COALESCE(excluded.artwork_url,tracks.artwork_url),source=COALESCE(excluded.source,tracks.source),source_id=COALESCE(excluded.source_id,tracks.source_id),source_url=COALESCE(excluded.source_url,tracks.source_url),metadata_json=COALESCE(excluded.metadata_json,tracks.metadata_json),cache_requested=MAX(tracks.cache_requested,excluded.cache_requested),updated_at=CURRENT_TIMESTAMP""",
                    values,
                ))

        if statements:
            await self.db.batch(statements)
        return len(tracks), failed

    async def start_import(self, filename, total):
        job_id = str(uuid.uuid4())
        await self.db.execute("INSERT INTO import_jobs(id,filename,status,total_rows,started_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)", [job_id, filename, "running", total])
        return job_id

    async def import_chunk(self, job_id, rows, done=False):
        if not rows or len(rows) > self.SEED_CHUNK_SIZE:
            raise ValueError(f"chunk must contain 1-{self.SEED_CHUNK_SIZE} rows")
        job = await self.db.one("SELECT * FROM import_jobs WHERE id=?", [job_id])
        if not job:
            raise ValueError("Import job not found")

        imported, failed = await self._insert_import_rows(job_id, rows)
        processed = job["processed_rows"] + len(rows)
        total_imported = job["imported_rows"] + imported
        total_failed = job["failed_rows"] + failed

        # Add playlist entries for this chunk only; never rebuild the whole
        # playlist at the end of a large import.
        tracks = [self._track(row) for row in rows]
        predicates = []
        params = []
        for track in tracks:
            if track.get("isrc"):
                predicates.append("t.isrc=?")
                params.append(track["isrc"])
            else:
                predicates.append("t.title=? AND t.artist=? AND COALESCE(t.album_name,'')=COALESCE(?, '')")
                params.extend([track["title"], track["artist"], track.get("album")])
        if predicates:
            sql = f"""INSERT OR IGNORE INTO playlist_entries(track_id,position) SELECT t.id, COALESCE((SELECT MAX(position)+1 FROM playlist_entries),0)+ROW_NUMBER() OVER (ORDER BY t.id)-1 FROM tracks t LEFT JOIN playlist_entries p ON p.track_id=t.id WHERE p.track_id IS NULL AND ({' OR '.join(predicates)})"""
            await self.db.execute(sql, params)

        if done:
            await self.db.execute("UPDATE import_jobs SET status='complete',processed_rows=?,imported_rows=?,failed_rows=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?", [processed, total_imported, total_failed, job_id])
        else:
            await self.db.execute("UPDATE import_jobs SET processed_rows=?,imported_rows=?,failed_rows=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", [processed, total_imported, total_failed, job_id])

        return {"ok": True, "job_id": job_id, "processed": processed, "total": job["total_rows"], "imported": total_imported, "failed": total_failed, "complete": done}

    async def import_csv(self, filename: str, content: bytes):
        rows = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
        job_id = await self.start_import(filename, len(rows))
        for i in range(0, len(rows), self.SEED_CHUNK_SIZE):
            await self.import_chunk(job_id, rows[i:i + self.SEED_CHUNK_SIZE], i + self.SEED_CHUNK_SIZE >= len(rows))
        return await self.import_job(job_id)

    async def import_job(self, job_id):
        return await self.db.one("SELECT * FROM import_jobs WHERE id=?", [job_id])

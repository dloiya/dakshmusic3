from __future__ import annotations

import asyncio
import csv
import io
import uuid

from ...config import Settings
from ...connectors.cloudflare.r2 import R2Client
from ...connectors.deezer import DeezerConnector
from ...repositories import D1Repository, LibraryRepository


class DataService:
    SEED_CHUNK_SIZE = 10
    METADATA_CONCURRENCY = 2

    def __init__(self, settings: Settings, db: D1Repository):
        self.settings = settings
        self.db = db
        self.library = LibraryRepository(db)
        self.r2 = R2Client(settings)
        self.deezer = DeezerConnector()

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
        return {
            "title": title,
            "artist": artist,
            "album": album,
            "isrc": isrc,
            "apple_id": apple_id,
            "playlist": playlist,
            "type": track_type,
            "cache": int(cache.lower() in {"1", "true", "yes", "y"}),
        }

    @staticmethod
    def _norm(value):
        return " ".join(str(value or "").casefold().split())

    async def _metadata_for_track(self, track):
        """Resolve metadata without blocking the seed request on many concurrent calls.

        ISRC is the first lookup key. Deezer's public search API does not return an
        ISRC in its search payload, so a result is accepted only when its title and
        artist match the imported row. If ISRC search cannot resolve it, the same
        matching logic falls back to title + artist.
        """
        queries = []
        if track.get("isrc"):
            queries.append(track["isrc"])
        queries.append(f'{track["title"]} {track["artist"]}')

        wanted_title = self._norm(track["title"])
        wanted_artist = self._norm(track["artist"])
        wanted_album = self._norm(track.get("album"))

        for query in queries:
            try:
                results = await self.deezer.search(query, limit=8)
            except Exception:
                continue
            best = None
            for item in results:
                title = self._norm(item.get("title"))
                artist = self._norm(item.get("artist"))
                album = self._norm(item.get("album_name"))
                if title != wanted_title or artist != wanted_artist:
                    continue
                score = 2
                if wanted_album and album == wanted_album:
                    score += 1
                if best is None or score > best[0]:
                    best = (score, item)
            if best:
                return best[1]
        return None

    async def _enrich_metadata(self, tracks):
        semaphore = asyncio.Semaphore(self.METADATA_CONCURRENCY)

        async def resolve(track):
            async with semaphore:
                return track, await self._metadata_for_track(track)

        results = await asyncio.gather(*(resolve(track) for track in tracks), return_exceptions=True)
        statements = []
        enriched = 0
        for result in results:
            if isinstance(result, Exception):
                continue
            track, metadata = result
            if not metadata:
                continue
            statements.append((
                """UPDATE tracks SET
                    duration_ms=COALESCE(?,duration_ms),
                    artwork_url=COALESCE(?,artwork_url),
                    source=COALESCE(?,source),
                    source_id=COALESCE(?,source_id),
                    source_url=COALESCE(?,source_url),
                    album_name=COALESCE(NULLIF(album_name,''),?),
                    updated_at=CURRENT_TIMESTAMP
                WHERE (isrc IS NOT NULL AND ? IS NOT NULL AND LOWER(isrc)=LOWER(?))
                   OR (LOWER(TRIM(title))=LOWER(TRIM(?)) AND LOWER(TRIM(artist))=LOWER(TRIM(?)))""",
                [metadata.get("duration_ms"), metadata.get("artwork_url"), metadata.get("source"), metadata.get("source_id"), metadata.get("source_url"), metadata.get("album_name"), track.get("isrc"), track.get("isrc"), track["title"], track["artist"]],
            ))
            enriched += 1
        if statements:
            await self.db.batch(statements)
        return enriched

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
            statements.append((
                """UPDATE tracks SET title=?,artist=?,album_name=?,isrc=COALESCE(?,isrc),cache_requested=MAX(cache_requested,?),updated_at=CURRENT_TIMESTAMP
                WHERE (isrc IS NOT NULL AND ? IS NOT NULL AND LOWER(isrc)=LOWER(?))
                   OR (LOWER(TRIM(title))=LOWER(TRIM(?)) AND LOWER(TRIM(COALESCE(artist,'')))=LOWER(TRIM(?)) AND LOWER(TRIM(COALESCE(album_name,'')))=LOWER(TRIM(COALESCE(?,''))))""",
                [track["title"],track["artist"],track["album"],track["isrc"],track["cache"],track["isrc"],track["isrc"],track["title"],track["artist"],track["album"]],
            ))
            statements.append((
                """INSERT INTO tracks(title,artist,album_name,isrc,cache_requested) SELECT ?,?,?,?,?
                WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE (isrc IS NOT NULL AND ? IS NOT NULL AND LOWER(isrc)=LOWER(?)) OR (LOWER(TRIM(title))=LOWER(TRIM(?)) AND LOWER(TRIM(artist))=LOWER(TRIM(?)) AND LOWER(TRIM(COALESCE(album_name,'')))=LOWER(TRIM(COALESCE(?,'')))))""",
                [track["title"],track["artist"],track["album"],track["isrc"],track["cache"],track["isrc"],track["isrc"],track["title"],track["artist"],track["album"]],
            ))
        if statements:
            await self.db.batch(statements)
        enriched = await self._enrich_metadata(tracks)
        return len(tracks), failed, enriched

    async def start_import(self, filename, total):
        job_id = str(uuid.uuid4())
        await self.db.execute("INSERT INTO import_jobs(id,filename,status,total_rows,started_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)", [job_id,filename,"running",total])
        return job_id

    async def import_chunk(self, job_id, rows, done=False):
        if not rows or len(rows) > self.SEED_CHUNK_SIZE:
            raise ValueError(f"chunk must contain 1-{self.SEED_CHUNK_SIZE} rows")
        job = await self.db.one("SELECT * FROM import_jobs WHERE id=?", [job_id])
        if not job:
            raise ValueError("Import job not found")
        imported, failed, enriched = await self._insert_import_rows(job_id, rows)
        processed = job["processed_rows"] + len(rows)
        total_imported = job["imported_rows"] + imported
        total_failed = job["failed_rows"] + failed
        if done:
            await self.db.execute("DELETE FROM playlist_entries WHERE id NOT IN (SELECT MIN(id) FROM playlist_entries GROUP BY track_id)")
            await self.db.execute("INSERT INTO playlist_entries(track_id,position) SELECT t.id,COALESCE((SELECT MAX(position)+1 FROM playlist_entries),0)+ROW_NUMBER() OVER (ORDER BY t.id)-1 FROM tracks t LEFT JOIN playlist_entries p ON p.track_id=t.id WHERE p.track_id IS NULL")
            await self.db.execute("UPDATE import_jobs SET status='complete',processed_rows=?,imported_rows=?,failed_rows=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?", [processed,total_imported,total_failed,job_id])
        else:
            await self.db.execute("UPDATE import_jobs SET processed_rows=?,imported_rows=?,failed_rows=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", [processed,total_imported,total_failed,job_id])
        return {"ok":True,"job_id":job_id,"processed":processed,"total":job["total_rows"],"imported":total_imported,"failed":total_failed,"metadata_enriched":enriched,"complete":done}

    async def import_csv(self, filename: str, content: bytes):
        rows = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
        job_id = await self.start_import(filename, len(rows))
        for i in range(0,len(rows),self.SEED_CHUNK_SIZE):
            await self.import_chunk(job_id,rows[i:i+self.SEED_CHUNK_SIZE],i+self.SEED_CHUNK_SIZE>=len(rows))
        return await self.import_job(job_id)

    async def import_job(self, job_id):
        return await self.db.one("SELECT * FROM import_jobs WHERE id=?", [job_id])

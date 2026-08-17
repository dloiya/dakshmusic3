from __future__ import annotations

import asyncio
import csv
import difflib
import io
import uuid

import httpx

from ...config import Settings
from ...connectors.cloudflare.r2 import R2Client
from ...connectors.deezer import DeezerConnector
from ...repositories import D1Repository, LibraryRepository


class DataService:
    def __init__(self, settings: Settings, db: D1Repository):
        self.settings = settings
        self.db = db
        self.library = LibraryRepository(db)
        self.r2 = R2Client(settings)
        self.deezer = DeezerConnector()
        self.deezer.base_url = settings.deezer_api_url.rstrip("/")

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
        title = cls._v(row, "track_name", "track title", "title", "song title", "name") or "Unknown"
        artist = cls._v(row, "artist_name", "artist", "artists", "track artist") or "Unknown"
        album = cls._v(row, "album", "album_name", "album_title")
        isrc = cls._v(row, "isrc")
        apple_id = cls._v(row, "apple_id", "apple id", "apple - id")
        cache = cls._v(row, "100cache", "100 cache", "cache", "top cache") or ""
        return {
            "title": title,
            "artist": artist,
            "album": album,
            "isrc": isrc,
            "apple_id": apple_id,
            "cache": int(cache.lower() in {"1", "true", "yes", "y"}),
        }

    @staticmethod
    def _score(item, track):
        title = difflib.SequenceMatcher(None, (item.get("title") or "").casefold(), track["title"].casefold()).ratio()
        artist = difflib.SequenceMatcher(None, (item.get("artist") or "").casefold(), track["artist"].casefold()).ratio()
        album = difflib.SequenceMatcher(None, (item.get("album_name") or "").casefold(), (track["album"] or "").casefold()).ratio() if track["album"] else 0.0
        return title * 0.55 + artist * 0.35 + album * 0.10

    async def _apple_metadata(self, track):
        """Use Apple's catalog first because the CSV already contains Apple IDs."""
        params = {"country": "us", "entity": "song"}
        if track.get("apple_id"):
            params["id"] = track["apple_id"]
        elif track.get("isrc"):
            params = {"term": track["isrc"], "country": "us", "entity": "song", "limit": 10}
        else:
            params = {"term": f'{track["artist"]} {track["title"]}', "country": "us", "entity": "song", "limit": 10}

        try:
            async with httpx.AsyncClient(timeout=12) as client:
                response = await client.get("https://itunes.apple.com/search", params=params)
                response.raise_for_status()
                data = response.json()
        except Exception:
            return {}

        results = data.get("results") or []
        if not results:
            return {}

        if track.get("apple_id"):
            result = next((x for x in results if str(x.get("trackId")) == str(track["apple_id"])), results[0])
        else:
            result = max(results, key=lambda x: self._score({
                "title": x.get("trackName"),
                "artist": x.get("artistName"),
                "album_name": x.get("collectionName"),
            }, track))
            if self._score({
                "title": result.get("trackName"),
                "artist": result.get("artistName"),
                "album_name": result.get("collectionName"),
            }, track) < 0.50:
                return {}

        return {
            "source": "apple",
            "source_id": str(result.get("trackId")) if result.get("trackId") else None,
            "source_url": result.get("trackViewUrl"),
            "duration_ms": result.get("trackTimeMillis"),
            "artwork_url": result.get("artworkUrl100") or result.get("artworkUrl60"),
            "album_name": result.get("collectionName"),
            "title": result.get("trackName"),
            "artist": result.get("artistName"),
        }

    async def _deezer_metadata(self, track):
        queries = [f'{track["artist"]} {track["title"]}']
        if track.get("isrc"):
            queries.insert(0, track["isrc"])
        for query in queries:
            try:
                results = await self.deezer.search(query, limit=10)
                if not results:
                    continue
                best = max(results, key=lambda item: self._score(item, track))
                if self._score(best, track) >= 0.50 and best.get("source_id"):
                    return await self.deezer.metadata(best["source_id"])
            except Exception:
                continue
        return {}

    async def _metadata(self, track):
        # Apple ID -> ISRC/title lookup. Deezer is a fallback for anything Apple
        # cannot resolve. This guarantees the CSV's Apple - id is actually used.
        metadata = await self._apple_metadata(track)
        if metadata:
            return metadata
        return await self._deezer_metadata(track)

    async def _enrich_rows(self, tracks):
        semaphore = asyncio.Semaphore(8)

        async def enrich(track):
            async with semaphore:
                metadata = await self._metadata(track)
                if metadata:
                    for field in ("duration_ms", "artwork_url", "source", "source_id", "source_url"):
                        if metadata.get(field) is not None:
                            track[field] = metadata[field]
                    if metadata.get("album_name") and not track.get("album"):
                        track["album"] = metadata["album_name"]
                return track

        return await asyncio.gather(*(enrich(track) for track in tracks))

    async def _insert_import_rows(self, job_id, rows):
        tracks = []
        seen = set()
        failed = 0
        for row in rows:
            try:
                track = self._track(row)
                key = ("isrc", track["isrc"].casefold()) if track["isrc"] else ("apple", track["apple_id"]) if track["apple_id"] else ("text", track["title"].casefold(), track["artist"].casefold(), (track["album"] or "").casefold())
                if key not in seen:
                    seen.add(key)
                    tracks.append(track)
            except Exception:
                failed += 1

        tracks = list(await self._enrich_rows(tracks))
        statements = []
        for track in tracks:
            statements.append((
                """UPDATE tracks SET
                    title=?, artist=?, album_name=?,
                    source=COALESCE(?,source), source_id=COALESCE(?,source_id),
                    source_url=COALESCE(?,source_url), isrc=COALESCE(?,isrc),
                    duration_ms=COALESCE(?,duration_ms), artwork_url=COALESCE(?,artwork_url),
                    cache_requested=MAX(cache_requested,?), updated_at=CURRENT_TIMESTAMP
                WHERE (isrc IS NOT NULL AND ? IS NOT NULL AND LOWER(isrc)=LOWER(?))
                   OR (LOWER(TRIM(title))=LOWER(TRIM(?))
                       AND LOWER(TRIM(COALESCE(artist,''))) IN (LOWER(TRIM(?)), 'unknown')
                       AND LOWER(TRIM(COALESCE(album_name,'')))=LOWER(TRIM(COALESCE(?,''))))""",
                [track["title"], track["artist"], track["album"], track.get("source"), track.get("source_id"), track.get("source_url"), track["isrc"], track.get("duration_ms"), track.get("artwork_url"), track["cache"], track["isrc"], track["isrc"], track["title"], track["artist"], track["album"]]
            ))
            statements.append((
                """INSERT INTO tracks(title,artist,album_name,source,source_id,source_url,isrc,duration_ms,artwork_url,cache_requested)
                SELECT ?,?,?,?,?,?,?,?,?,?
                WHERE NOT EXISTS (
                    SELECT 1 FROM tracks WHERE
                    (isrc IS NOT NULL AND ? IS NOT NULL AND LOWER(isrc)=LOWER(?))
                    OR (LOWER(TRIM(title))=LOWER(TRIM(?))
                        AND LOWER(TRIM(artist))=LOWER(TRIM(?))
                        AND LOWER(TRIM(COALESCE(album_name,'')))=LOWER(TRIM(COALESCE(?,''))))
                )""",
                [track["title"], track["artist"], track["album"], track.get("source"), track.get("source_id"), track.get("source_url"), track["isrc"], track.get("duration_ms"), track.get("artwork_url"), track["cache"], track["isrc"], track["isrc"], track["title"], track["artist"], track["album"]]
            ))
        if statements:
            await self.db.batch(statements)
        return len(tracks), failed

    async def start_import(self, filename, total):
        job_id = str(uuid.uuid4())
        await self.db.execute("INSERT INTO import_jobs(id,filename,status,total_rows,started_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)", [job_id, filename, "running", total])
        return job_id

    async def import_chunk(self, job_id, rows, done=False):
        job = await self.db.one("SELECT * FROM import_jobs WHERE id=?", [job_id])
        if not job:
            raise ValueError("Import job not found")
        imported, failed = await self._insert_import_rows(job_id, rows)
        processed = job["processed_rows"] + len(rows)
        total_imported = job["imported_rows"] + imported
        total_failed = job["failed_rows"] + failed
        if done:
            await self.db.execute("DELETE FROM playlist_entries WHERE id NOT IN (SELECT MIN(id) FROM playlist_entries GROUP BY track_id)")
            await self.db.execute("""INSERT INTO playlist_entries(track_id,position)
                SELECT t.id,COALESCE((SELECT MAX(position)+1 FROM playlist_entries),0)+ROW_NUMBER() OVER (ORDER BY t.id)-1
                FROM tracks t LEFT JOIN playlist_entries p ON p.track_id=t.id WHERE p.track_id IS NULL""")
            await self.db.execute("UPDATE import_jobs SET status='complete',processed_rows=?,imported_rows=?,failed_rows=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?", [processed, total_imported, total_failed, job_id])
        else:
            await self.db.execute("UPDATE import_jobs SET processed_rows=?,imported_rows=?,failed_rows=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", [processed, total_imported, total_failed, job_id])
        return {"ok": True, "job_id": job_id, "processed": processed, "total": job["total_rows"], "imported": total_imported, "failed": total_failed, "complete": done}

    async def import_csv(self, filename: str, content: bytes):
        rows = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
        job_id = await self.start_import(filename, len(rows))
        for i in range(0, len(rows), 100):
            await self.import_chunk(job_id, rows[i:i + 100], i + 100 >= len(rows))
        return await self.import_job(job_id)

    async def import_job(self, job_id):
        return await self.db.one("SELECT * FROM import_jobs WHERE id=?", [job_id])

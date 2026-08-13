-- Adds denormalized song metadata to playlist_entries and enforces
-- one entry per track (dedup). Safe to run against an existing
-- database with data already in it; NOT safe to run twice on a
-- database where the columns already exist (ALTER TABLE ADD COLUMN
-- will error if the column is already present).
--
-- Run with:
--   wrangler d1 execute dakshmusic3 --remote --file=./serverless/migrations/001_playlist_entries_dedup_and_metadata.sql
-- or paste into the D1 dashboard console one statement at a time if
-- your console only accepts a single statement per run.

ALTER TABLE playlist_entries ADD COLUMN title TEXT;
ALTER TABLE playlist_entries ADD COLUMN artist TEXT;
ALTER TABLE playlist_entries ADD COLUMN album TEXT;
ALTER TABLE playlist_entries ADD COLUMN artwork_url TEXT;
ALTER TABLE playlist_entries ADD COLUMN duration_ms INTEGER;

-- Backfill the new columns from the tracks table for any rows added
-- before this migration.
UPDATE playlist_entries
SET
  title = (SELECT title FROM tracks WHERE tracks.id = playlist_entries.track_id),
  artist = (SELECT artist FROM tracks WHERE tracks.id = playlist_entries.track_id),
  album = (SELECT album FROM tracks WHERE tracks.id = playlist_entries.track_id),
  artwork_url = (SELECT artwork_url FROM tracks WHERE tracks.id = playlist_entries.track_id),
  duration_ms = (SELECT duration_ms FROM tracks WHERE tracks.id = playlist_entries.track_id);

-- Remove any pre-existing duplicate entries for the same track,
-- keeping the earliest one. Required before the UNIQUE index below
-- can be created -- it will fail if duplicates still exist.
DELETE FROM playlist_entries
WHERE id NOT IN (
  SELECT MIN(id) FROM playlist_entries GROUP BY track_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_entries_track_unique ON playlist_entries(track_id);

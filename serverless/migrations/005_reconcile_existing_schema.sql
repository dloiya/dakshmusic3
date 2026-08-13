-- Reconciliation migration for production D1 databases that already contain
-- portions of migrations 001-004 but do not have matching Wrangler history.
-- SQLite/D1 does not support ADD COLUMN IF NOT EXISTS, so this migration is
-- intentionally limited to schema changes that are known to be missing in
-- production and can be applied once after the failed migration chain is
-- reconciled.
--
-- The production failure showed playlist_entries.title already exists, so
-- migration 001 must NOT be replayed against that database.
-- The missing production column reported by /library/seed is tracks.isrc.

ALTER TABLE tracks ADD COLUMN isrc TEXT;
CREATE INDEX IF NOT EXISTS idx_tracks_isrc ON tracks(isrc);

UPDATE tracks SET play_count = 0 WHERE play_count IS NULL OR play_count <> 0;

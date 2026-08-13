-- Production reconciliation baseline.
-- The production D1 database already contains the playlist_entries metadata
-- columns from the original version of migration 001. Do not replay ALTER TABLE
-- statements against production because SQLite/D1 has no ADD COLUMN IF NOT EXISTS.
-- The unique playlist-entry index is idempotent and is retained here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_entries_track_unique ON playlist_entries(track_id);

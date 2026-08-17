-- Persist the enriched Deezer/Apple metadata carried by the new CSV.
-- The import service reads this JSON without making remote metadata calls.
ALTER TABLE tracks ADD COLUMN metadata_json TEXT;
CREATE INDEX IF NOT EXISTS idx_tracks_isrc ON tracks(isrc);

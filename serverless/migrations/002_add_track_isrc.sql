ALTER TABLE tracks ADD COLUMN isrc TEXT;
CREATE INDEX IF NOT EXISTS idx_tracks_isrc ON tracks(isrc);

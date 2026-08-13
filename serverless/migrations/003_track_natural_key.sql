ALTER TABLE tracks ADD COLUMN natural_key TEXT;

UPDATE tracks SET natural_key = LOWER(TRIM(REPLACE(REPLACE(REPLACE(TRIM(title), ' ', '-'), '/', '-'), '''', ''), '-')) || '-' || LOWER(TRIM(REPLACE(REPLACE(REPLACE(TRIM(artist), ' ', '-'), '/', '-'), '''', ''), '-')) || '-' || LOWER(TRIM(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(album, 'unknown')), ' ', '-'), '/', '-'), '''', ''), '-')) || '-' || substr(created_at, 1, 10) WHERE natural_key IS NULL;

UPDATE tracks SET natural_key = natural_key || '-' || id WHERE id NOT IN (SELECT MIN(id) FROM tracks GROUP BY natural_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_natural_key ON tracks(natural_key);

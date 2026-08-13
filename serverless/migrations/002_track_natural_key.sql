-- Adds a natural_key column to tracks: songname-artist-album-date,
-- treated as the track's unique natural identity (used as the R2
-- storage filename going forward). The surrogate integer id column
-- remains the actual PRIMARY KEY -- every other table's foreign key
-- (playlist_entries, general_cache, top_played_cache, download_jobs,
-- album_cache) points at tracks(id) as an INTEGER, and rewriting all
-- of those to a composite text key would be a much larger, riskier
-- change than what this feature actually needs. natural_key gives you
-- the same practical effect (that tuple is what uniquely identifies
-- and names a stored song) without that blast radius.
--
-- Run with:
--   wrangler d1 execute dakshmusic3 --remote --file=./serverless/migrations/002_track_natural_key.sql
-- or paste into the D1 dashboard console one statement at a time if
-- your console only accepts a single statement per run.

ALTER TABLE tracks ADD COLUMN natural_key TEXT;

-- Backfill existing rows using their own creation date, sanitized the
-- same way new rows will be (lowercase, non-alphanumeric collapsed to
-- hyphens).
UPDATE tracks
SET natural_key =
  LOWER(
    TRIM(
      REPLACE(REPLACE(REPLACE(TRIM(title), ' ', '-'), '/', '-'), '''', ''),
      '-'
    )
  ) || '-' ||
  LOWER(
    TRIM(
      REPLACE(REPLACE(REPLACE(TRIM(artist), ' ', '-'), '/', '-'), '''', ''),
      '-'
    )
  ) || '-' ||
  LOWER(
    TRIM(
      REPLACE(REPLACE(REPLACE(TRIM(COALESCE(album, 'unknown')), ' ', '-'), '/', '-'), '''', ''),
      '-'
    )
  ) || '-' ||
  substr(created_at, 1, 10)
WHERE natural_key IS NULL;

-- Disambiguate any genuine collisions (two different tracks that
-- happen to share title+artist+album+creation-date) by appending
-- their row id, so the UNIQUE index below doesn't fail. This is a
-- fallback for an edge case, not the normal format going forward.
UPDATE tracks
SET natural_key = natural_key || '-' || id
WHERE id NOT IN (
  SELECT MIN(id) FROM tracks GROUP BY natural_key
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_natural_key ON tracks(natural_key);

-- Existing cached audio in R2 was stored under the old tracks/{id}.ext
-- key scheme and stays there -- this migration does not rename or move
-- any existing R2 objects, only changes the key format used for future
-- uploads. Old cached tracks keep working exactly as before; you'll
-- see the new naming scheme only for songs acquired after this ships.

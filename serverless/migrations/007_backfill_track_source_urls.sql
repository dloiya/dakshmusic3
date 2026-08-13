-- Backfill missing Apple Music source URLs for existing tracks.
-- Existing source URLs are never overwritten.
UPDATE tracks
SET source_url = 'https://music.apple.com/us/song/'
  || lower(trim(replace(replace(replace(title, ' ', '-'), '/', '-'), '?', '')))
  || '/'
  || replace(source_id, 'apple:', '')
WHERE source = 'apple'
  AND (source_url IS NULL OR source_url = '')
  AND source_id IS NOT NULL
  AND source_id <> '';

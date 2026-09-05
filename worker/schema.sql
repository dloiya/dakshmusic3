-- Reference only.
-- This mirrors the active DakshMusic3 D1 structure.
-- Do NOT blindly apply this to production if the tables already exist.

CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_id INTEGER,
  album_name TEXT,
  source TEXT,
  source_id TEXT,
  source_url TEXT,
  isrc TEXT,
  duration_ms INTEGER,
  artwork_url TEXT,
  storage_key TEXT,
  storage_status TEXT CHECK(storage_status IN ('missing','queued','available','failed')),
  play_count INTEGER DEFAULT 0,
  cache_requested INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  metadata_json TEXT,
  UNIQUE(title, artist, album_name)
);

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT,
  source TEXT,
  source_id TEXT,
  artwork_url TEXT,
  year INTEGER,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(source, source_id)
);

CREATE TABLE IF NOT EXISTS playlist_entries (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  added_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS queue_entries (
  id INTEGER PRIMARY KEY,
  queue_key TEXT NOT NULL,
  track_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  added_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS queue_state (
  queue_key TEXT PRIMARY KEY,
  current_index INTEGER DEFAULT 0,
  mode TEXT,
  shuffle_enabled INTEGER DEFAULT 1,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS acquisition_jobs (
  id TEXT PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  worker TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  storage_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS cache_objects (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL,
  scope TEXT,
  scope_id TEXT,
  storage_key TEXT,
  status TEXT,
  size_bytes INTEGER,
  last_accessed_at TEXT,
  expires_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tracks_source
  ON tracks(source, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_jobs_active_track
  ON acquisition_jobs(track_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_track_created
  ON acquisition_jobs(track_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_queue_entries_key
  ON queue_entries(queue_key, position);

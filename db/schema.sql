PRAGMA foreign_keys = ON;

CREATE TABLE albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  source TEXT,
  source_id TEXT,
  artwork_url TEXT,
  year INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_id)
);

CREATE TABLE tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
  album_name TEXT,
  source TEXT,
  source_id TEXT,
  source_url TEXT,
  isrc TEXT,
  duration_ms INTEGER,
  artwork_url TEXT,
  metadata_json TEXT,
  storage_key TEXT UNIQUE,
  storage_status TEXT NOT NULL DEFAULT 'missing' CHECK(storage_status IN ('missing','queued','available','failed')),
  play_count INTEGER NOT NULL DEFAULT 0,
  cache_requested INTEGER NOT NULL DEFAULT 0 CHECK(cache_requested IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(title, artist, album_name)
);

CREATE TABLE playlist_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL UNIQUE,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(track_id)
);

CREATE TABLE queue_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_key TEXT NOT NULL,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(queue_key, position),
  UNIQUE(queue_key, track_id)
);

CREATE TABLE queue_state (
  queue_key TEXT PRIMARY KEY,
  current_index INTEGER NOT NULL DEFAULT -1,
  mode TEXT NOT NULL DEFAULT 'manual',
  shuffle_enabled INTEGER NOT NULL DEFAULT 0 CHECK(shuffle_enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE acquisition_jobs (
  id TEXT PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatched','running','complete','failed','cancelled')),
  worker TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE cache_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('top','album','playlist','server')),
  scope_id TEXT,
  storage_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('queued','available','failed','expired')),
  size_bytes INTEGER,
  last_accessed_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(track_id, scope, scope_id)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','complete','failed','cancelled')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tracks_artist ON tracks(artist);
CREATE INDEX idx_tracks_album ON tracks(album_id);
CREATE INDEX idx_tracks_source ON tracks(source, source_id);
CREATE INDEX idx_tracks_isrc ON tracks(isrc);
CREATE INDEX idx_playlist_position ON playlist_entries(position);
CREATE INDEX idx_queue_key_position ON queue_entries(queue_key, position);
CREATE INDEX idx_acquisition_status ON acquisition_jobs(status, created_at);
CREATE INDEX idx_acquisition_track ON acquisition_jobs(track_id, status);
CREATE INDEX idx_cache_scope ON cache_objects(scope, scope_id, status);

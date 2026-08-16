CREATE TABLE IF NOT EXISTS queue_entries (
  user_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  track_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_key, position),
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_queue_entries_user_track ON queue_entries(user_key, track_id);

CREATE TABLE IF NOT EXISTS queue_state (
  user_key TEXT PRIMARY KEY,
  current_index INTEGER NOT NULL DEFAULT -1,
  mode TEXT NOT NULL DEFAULT 'manual',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
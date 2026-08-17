CREATE TABLE IF NOT EXISTS queue_entries (
  user_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  track_id INTEGER NOT NULL,
  PRIMARY KEY (user_key, position),
  UNIQUE (user_key, track_id),
  FOREIGN KEY (track_id) REFERENCES tracks(id)
);

CREATE INDEX IF NOT EXISTS idx_queue_entries_user_track
  ON queue_entries(user_key, track_id);

CREATE TABLE IF NOT EXISTS queue_state (
  user_key TEXT PRIMARY KEY,
  current_index INTEGER NOT NULL DEFAULT -1,
  mode TEXT NOT NULL DEFAULT 'manual',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
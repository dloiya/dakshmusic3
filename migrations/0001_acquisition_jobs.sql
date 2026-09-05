-- Durable acquisition lifecycle.
-- This table is intentionally separate from queue_entries: queue_entries is the
-- playback queue; acquisition_jobs is the OCI/R2 acquisition state machine.

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_jobs_active_track
  ON acquisition_jobs(track_id)
  WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_track_created
  ON acquisition_jobs(track_id, created_at DESC);

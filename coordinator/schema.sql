CREATE TABLE IF NOT EXISTS acquisition_jobs (
 id TEXT PRIMARY KEY,
 url TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued',
 attempts INTEGER NOT NULL DEFAULT 0,
 worker_id TEXT,
 lease_expires_at TEXT,
 last_error TEXT,
 storage_key TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_claim ON acquisition_jobs(status,created_at);
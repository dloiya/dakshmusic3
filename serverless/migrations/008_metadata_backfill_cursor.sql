-- Add the persistent cursor required by the resumable metadata backfill.
-- The table may already exist from an earlier backfill implementation.
ALTER TABLE metadata_backfill_state ADD COLUMN cursor_id INTEGER NOT NULL DEFAULT 0;

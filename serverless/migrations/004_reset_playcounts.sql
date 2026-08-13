-- Play counts are intentionally disabled for the current library model.
-- Album playback must not contribute to track play counts.
UPDATE tracks SET play_count = 0;

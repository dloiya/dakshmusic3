-- Keep all existing play counts at zero while play-count accounting is disabled.
UPDATE tracks SET play_count = 0;

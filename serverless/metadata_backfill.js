function normIsrc(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function deezerMeta(data, method) {
  if (!data?.id || data?.error) return null;
  return {
    duration_ms: Number(data.duration) > 0 ? Number(data.duration) * 1000 : null,
    artwork_url: data.album?.cover_xl || data.album?.cover_big || data.album?.cover_medium || data.album?.cover || null,
    method,
  };
}

async function deezerIsrc(isrc) {
  const code = normIsrc(isrc);
  if (!code) return null;
  try {
    const response = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(code)}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (normIsrc(data?.isrc) !== code) return null;
    return deezerMeta(data, "deezer_isrc");
  } catch (_) {
    return null;
  }
}

async function musicBrainzIsrc(isrc) {
  const code = normIsrc(isrc);
  if (!code) return null;
  try {
    const response = await fetch(`https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(code)}?fmt=json`, {
      headers: { accept: "application/json", "User-Agent": "dakshmusic3/1.0 (metadata backfill)" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const recordings = data.recordings || [];
    const recording = recordings.find(r => Number(r.length) > 0) || recordings[0];
    if (!recording) return null;
    return {
      duration_ms: Number(recording.length) > 0 ? Number(recording.length) : null,
      artwork_url: null,
      method: "musicbrainz_isrc",
    };
  } catch (_) {
    return null;
  }
}

export async function backfillMissingMetadata(env, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 20));
  // Cloudflare currently allows six simultaneous outgoing connections per invocation.
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 6, 6));

  // Persist a cursor so unresolved rows cannot block the rest of the catalog.
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS metadata_backfill_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      cursor_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO metadata_backfill_state(id,cursor_id) VALUES(1,0)`).run();

  let state = await env.DB.prepare(`SELECT cursor_id FROM metadata_backfill_state WHERE id=1`).first();
  let cursor = Number(state?.cursor_id || 0);

  let { results = [] } = await env.DB.prepare(`
    SELECT id, source, source_id, title, artist, album, isrc, duration_ms, artwork_url
    FROM tracks
    WHERE id>? AND (duration_ms IS NULL OR duration_ms<=0 OR artwork_url IS NULL OR artwork_url='')
    ORDER BY id
    LIMIT ?
  `).bind(cursor, limit).all();

  // Start a new pass once the cursor reaches the end of the catalog.
  if (!results.length && cursor > 0) {
    cursor = 0;
    await env.DB.prepare(`UPDATE metadata_backfill_state SET cursor_id=0,updated_at=CURRENT_TIMESTAMP WHERE id=1`).run();
    ({ results = [] } = await env.DB.prepare(`
      SELECT id, source, source_id, title, artist, album, isrc, duration_ms, artwork_url
      FROM tracks
      WHERE duration_ms IS NULL OR duration_ms<=0 OR artwork_url IS NULL OR artwork_url=''
      ORDER BY id
      LIMIT ?
    `).bind(limit).all());
  }

  const stats = {
    checked: results.length,
    deezer_isrc: 0,
    musicbrainz_isrc: 0,
    unresolved: 0,
    enriched: 0,
    repaired: 0,
    duration_filled: 0,
    artwork_filled: 0,
    cursor_before: cursor,
    cursor_after: cursor,
  };

  for (let offset = 0; offset < results.length; offset += concurrency) {
    const chunk = results.slice(offset, offset + concurrency);
    const resolved = await Promise.all(chunk.map(async track => {
      let meta = await deezerIsrc(track.isrc);
      let method = meta?.method || null;
      if (meta) stats.deezer_isrc++;

      // MusicBrainz only supplies the missing duration; Deezer remains the artwork authority.
      if ((!meta?.duration_ms) && track.isrc) {
        const mb = await musicBrainzIsrc(track.isrc);
        if (mb?.duration_ms) {
          stats.musicbrainz_isrc++;
          meta = {
            duration_ms: mb.duration_ms,
            artwork_url: meta?.artwork_url || null,
            method: method ? `${method}+musicbrainz_isrc` : mb.method,
          };
        }
      }
      return { track, meta };
    }));

    const writes = [];
    for (const { track, meta } of resolved) {
      if (!meta || (!meta.duration_ms && !meta.artwork_url)) {
        stats.unresolved++;
        continue;
      }

      const hadDuration = Number(track.duration_ms) > 0;
      const hadArtwork = !!String(track.artwork_url || "").trim();
      const duration = Number(meta.duration_ms) > 0 ? Math.round(Number(meta.duration_ms)) : null;
      const artwork = meta.artwork_url ? String(meta.artwork_url) : null;
      const durationToWrite = !hadDuration ? duration : null;
      const artworkToWrite = !hadArtwork ? artwork : null;

      if (durationToWrite) stats.duration_filled++;
      if (artworkToWrite) stats.artwork_filled++;
      if (!durationToWrite && !artworkToWrite) continue;

      stats.enriched++;
      writes.push(env.DB.prepare(`
        UPDATE tracks
        SET duration_ms=COALESCE(?,duration_ms),
            artwork_url=COALESCE(?,artwork_url),
            updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).bind(durationToWrite, artworkToWrite, track.id));

      writes.push(env.DB.prepare(`
        UPDATE playlist_entries
        SET duration_ms=COALESCE(?,duration_ms),
            artwork_url=COALESCE(?,artwork_url)
        WHERE track_id=?
      `).bind(durationToWrite, artworkToWrite, track.id));
    }

    if (writes.length) await env.DB.batch(writes);
  }

  if (results.length) {
    const nextCursor = Math.max(...results.map(row => Number(row.id) || 0));
    stats.cursor_after = nextCursor;
    await env.DB.prepare(`UPDATE metadata_backfill_state SET cursor_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`).bind(nextCursor).run();
  }

  return stats;
}

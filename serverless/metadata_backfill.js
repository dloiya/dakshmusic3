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
    return normIsrc(data?.isrc) === code ? deezerMeta(data, "deezer_isrc") : null;
  } catch (_) {
    return null;
  }
}

async function musicBrainzIsrc(isrc) {
  const code = normIsrc(isrc);
  if (!code) return null;
  try {
    const response = await fetch(`https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(code)}?fmt=json`, {
      headers: { Accept: "application/json", "User-Agent": "dakshmusic3/1.0 (metadata-backfill)" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const recording = (data.recordings || []).find(r => Number(r.length) > 0) || data.recordings?.[0];
    if (!recording) return null;
    return { duration_ms: Number(recording.length) > 0 ? Number(recording.length) : null, artwork_url: null, method: "musicbrainz_isrc" };
  } catch (_) {
    return null;
  }
}

async function ensureState(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metadata_backfill_state (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO metadata_backfill_state(id,cursor) VALUES(1,0)`).run();
}

export async function backfillMissingMetadata(env, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 20));
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 10, 10));
  await ensureState(env);

  let state = await env.DB.prepare(`SELECT cursor FROM metadata_backfill_state WHERE id=1`).first();
  let cursor = Number(state?.cursor || 0);
  let { results = [] } = await env.DB.prepare(`
    SELECT id,source,source_id,title,artist,album,isrc,duration_ms,artwork_url
    FROM tracks
    WHERE id>? AND (duration_ms IS NULL OR duration_ms<=0 OR artwork_url IS NULL OR artwork_url='')
    ORDER BY id LIMIT ?
  `).bind(cursor, limit).all();

  // If the cursor reached the end of the current catalog, start a new pass.
  if (!results.length && cursor !== 0) {
    cursor = 0;
    await env.DB.prepare(`UPDATE metadata_backfill_state SET cursor=0,updated_at=CURRENT_TIMESTAMP WHERE id=1`).run();
    ({ results = [] } = await env.DB.prepare(`
      SELECT id,source,source_id,title,artist,album,isrc,duration_ms,artwork_url
      FROM tracks
      WHERE duration_ms IS NULL OR duration_ms<=0 OR artwork_url IS NULL OR artwork_url=''
      ORDER BY id LIMIT ?
    `).bind(limit).all());
  }

  const stats = { checked: results.length, deezer_isrc: 0, musicbrainz_isrc: 0, unresolved: 0, enriched: 0, duration_filled: 0, artwork_filled: 0, cursor_start: cursor, cursor_end: cursor };

  for (let offset = 0; offset < results.length; offset += concurrency) {
    const chunk = results.slice(offset, offset + concurrency);
    const resolved = await Promise.all(chunk.map(async track => {
      let meta = await deezerIsrc(track.isrc);
      let method = meta?.method || null;
      if (!meta?.duration_ms && track.isrc) {
        const mb = await musicBrainzIsrc(track.isrc);
        if (mb?.duration_ms) {
          meta = { ...(meta || {}), duration_ms: mb.duration_ms, artwork_url: meta?.artwork_url || null, method: meta?.method || mb.method };
          method = meta.method;
        }
      }
      return { track, meta, method };
    }));

    const writes = [];
    for (const { track, meta } of resolved) {
      const hasDuration = Number(track.duration_ms) > 0;
      const hasArtwork = !!String(track.artwork_url || "").trim();
      const duration = !hasDuration && Number(meta?.duration_ms) > 0 ? Math.round(Number(meta.duration_ms)) : null;
      const artwork = !hasArtwork && meta?.artwork_url ? String(meta.artwork_url) : null;
      if (!duration && !artwork) {
        stats.unresolved++;
        continue;
      }
      writes.push(env.DB.prepare(`UPDATE tracks SET duration_ms=COALESCE(?,duration_ms),artwork_url=COALESCE(?,artwork_url),updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(duration, artwork, track.id));
      stats.enriched++;
      if (duration) stats.duration_filled++;
      if (artwork) stats.artwork_filled++;
      if (method === "deezer_isrc") stats.deezer_isrc++;
      if (method === "musicbrainz_isrc") stats.musicbrainz_isrc++;
    }
    if (writes.length) await env.DB.batch(writes);
  }

  if (results.length) {
    cursor = Number(results[results.length - 1].id);
    await env.DB.prepare(`UPDATE metadata_backfill_state SET cursor=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`).bind(cursor).run();
  }
  stats.cursor_end = cursor;

  // Keep the playlist projection in sync with the canonical track metadata.
  await env.DB.prepare(`
    UPDATE playlist_entries
    SET artwork_url=(SELECT artwork_url FROM tracks WHERE tracks.id=playlist_entries.track_id),
        duration_ms=(SELECT duration_ms FROM tracks WHERE tracks.id=playlist_entries.track_id)
    WHERE EXISTS (SELECT 1 FROM tracks WHERE tracks.id=playlist_entries.track_id)
  `).run();

  return stats;
}

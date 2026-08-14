function normIsrc(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(code)}`, {
        headers: { "accept": "application/json" },
      });
      if (response.ok) {
        const data = await response.json();
        const meta = deezerMeta(data, "deezer_isrc");
        if (meta) return meta;
      }
      if (response.status !== 429 && response.status < 500) return null;
    } catch (_) {}
    await sleep(500 * (attempt + 1));
  }
  return null;
}

async function musicBrainzIsrc(isrc) {
  const code = normIsrc(isrc);
  if (!code) return null;
  try {
    const response = await fetch(`https://musicbrainz.org/ws/2/recording/?query=isrc:${encodeURIComponent(code)}&fmt=json&limit=5`, {
      headers: { "User-Agent": "dakshmusic3/1.0 (metadata backfill)" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const recordings = (data.recordings || []).filter(r =>
      (r.isrcs || []).some(x => normIsrc(x) === code)
    );
    if (!recordings.length) return null;

    const recording = recordings.find(r => r.length) || recordings[0];
    let artwork_url = null;
    const release = (recording.releases || []).find(r => r.id);
    if (release?.id) {
      try {
        const cover = await fetch(`https://coverartarchive.org/release/${release.id}/front-500`);
        if (cover.ok || cover.status >= 300 && cover.status < 400) {
          artwork_url = cover.url || `https://coverartarchive.org/release/${release.id}/front-500`;
        }
      } catch (_) {}
    }

    return {
      duration_ms: Number(recording.length) > 0 ? Number(recording.length) : null,
      artwork_url,
      method: "musicbrainz_isrc",
    };
  } catch (_) {
    return null;
  }
}

export async function backfillMissingMetadata(env, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 500, 2000));
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 4, 8));
  const { results = [] } = await env.DB.prepare(`
    SELECT id, source, source_id, title, artist, album, isrc, duration_ms, artwork_url
    FROM tracks
    WHERE duration_ms IS NULL OR duration_ms <= 0 OR artwork_url IS NULL OR artwork_url=''
    ORDER BY id
    LIMIT ?
  `).bind(limit).all();

  const stats = {
    checked: results.length,
    deezer_isrc: 0,
    musicbrainz_isrc: 0,
    unresolved: 0,
    enriched: 0,
    repaired: 0,
  };

  for (let offset = 0; offset < results.length; offset += concurrency) {
    const chunk = results.slice(offset, offset + concurrency);
    const resolved = await Promise.all(chunk.map(async track => {
      let meta = await deezerIsrc(track.isrc);
      if (meta) stats.deezer_isrc++;
      if (!meta) {
        meta = await musicBrainzIsrc(track.isrc);
        if (meta) stats.musicbrainz_isrc++;
      }
      return { track, meta };
    }));

    const writes = [];
    for (const { track, meta } of resolved) {
      if (!meta || (!meta.duration_ms && !meta.artwork_url)) {
        stats.unresolved++;
        continue;
      }
      const hasDuration = Number(track.duration_ms) > 0;
      const hasArtwork = !!String(track.artwork_url || "").trim();
      const duration = meta.duration_ms || null;
      const artwork = meta.artwork_url || null;
      writes.push(env.DB.prepare(`
        UPDATE tracks
        SET duration_ms=COALESCE(?, duration_ms),
            artwork_url=COALESCE(?, artwork_url),
            updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).bind(duration, artwork, track.id));
      stats.enriched++;
      if ((hasDuration && duration) || (hasArtwork && artwork)) stats.repaired++;
    }
    if (writes.length) await env.DB.batch(writes);
  }

  return stats;
}

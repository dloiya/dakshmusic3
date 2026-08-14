const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...extra },
});

function cookie(req) {
  return (req.headers.get("Cookie") || "").match(/(?:^|;\s*)music_session=([^;]+)/)?.[1] || null;
}

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function requireAuth(env, req) {
  const token = cookie(req);
  if (!token || !env.DB) return false;
  const row = await env.DB.prepare(`SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?`)
    .bind(await sha256(token), Math.floor(Date.now() / 1000)).first();
  return !!row;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function excelCell(value, type = "String") { return `<Cell><Data ss:Type="${type}">${xmlEscape(value)}</Data></Cell>`; }
function excelWorkbook(rows) {
  const headers = ["Position", "Track ID", "Title", "Artist", "Album", "ISRC", "Source", "Source ID", "Duration (ms)", "Play Count", "Added At"];
  const header = `<Row>${headers.map(h => excelCell(h)).join("")}</Row>`;
  const body = rows.map(r => `<Row>${[
    excelCell(r.position, "Number"), excelCell(r.track_id, "Number"), excelCell(r.title), excelCell(r.artist), excelCell(r.album),
    excelCell(r.isrc), excelCell(r.source), excelCell(r.source_id), excelCell(r.duration_ms ?? "", r.duration_ms == null ? "String" : "Number"),
    excelCell(0, "Number"), excelCell(r.added_at),
  ].join("")}</Row>`).join("");
  return `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Playlist"><Table>${header}${body}</Table></Worksheet></Workbook>`;
}

async function findTrack(env, item) {
  if (item.isrc) {
    const byIsrc = await env.DB.prepare(`SELECT * FROM tracks WHERE UPPER(REPLACE(isrc,'-',''))=UPPER(REPLACE(?, '-','')) LIMIT 1`).bind(item.isrc).first();
    if (byIsrc) return byIsrc;
  }
  if (item.source_id) {
    const bySource = await env.DB.prepare(`SELECT * FROM tracks WHERE source_id=? LIMIT 1`).bind(String(item.source_id)).first();
    if (bySource) return bySource;
  }
  return await env.DB.prepare(`SELECT * FROM tracks WHERE LOWER(title)=LOWER(?) AND LOWER(artist)=LOWER(?) AND LOWER(COALESCE(album,''))=LOWER(COALESCE(?,'')) LIMIT 1`).bind(item.title || "", item.artist || "", item.album || "").first();
}

async function resolveMissingDuration(env, track) {
  if (track?.duration_ms && Number(track.duration_ms) > 0) return track;

  const source = String(track?.source || "").toLowerCase();
  let duration = null;

  try {
    if (source === "apple") {
      // Accept numeric IDs, apple-123/apple:123 IDs, and Apple Music URLs.
      let appleId = String(track.source_id || "").trim().match(/(?:^apple[-_:])?(\d+)$/i)?.[1] || null;
      if (!appleId && track.source_url) {
        appleId = String(track.source_url).match(/\/song\/[^/?#]+\/(\d+)(?:\?|#|$)/i)?.[1] || null;
      }

      if (appleId) {
        const response = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appleId)}&entity=song`);
        if (response.ok) {
          const data = await response.json();
          const song = (data.results || []).find(item => item.wrapperType === "track" && Number(item.trackTimeMillis) > 0);
          duration = Number(song?.trackTimeMillis) || null;
        }
      }

      // Fall back to exact Apple catalog metadata if an imported row has no usable ID.
      if (!duration && track.title && track.artist) {
        const term = encodeURIComponent(`${track.title} ${track.artist}`);
        const response = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=25`);
        if (response.ok) {
          const data = await response.json();
          const wantedTitle = String(track.title).toLowerCase().trim();
          const wantedArtist = String(track.artist).toLowerCase().trim();
          const results = (data.results || []).filter(item => Number(item.trackTimeMillis) > 0);
          const exact = results.find(item =>
            String(item.trackName || "").toLowerCase().trim() === wantedTitle &&
            String(item.artistName || "").toLowerCase().trim() === wantedArtist
          );
          if (exact) duration = Number(exact.trackTimeMillis);
        }
      }
    }

    if (!duration && source === "deezer" && track.source_id) {
      const response = await fetch(`https://api.deezer.com/track/${encodeURIComponent(track.source_id)}`);
      if (response.ok) {
        const data = await response.json();
        if (Number(data?.duration) > 0) duration = Number(data.duration) * 1000;
      }
    }

    if (!duration && track.source_url) {
      const match = String(track.source_url).match(/deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/i);
      if (match) {
        const response = await fetch(`https://api.deezer.com/track/${match[1]}`);
        if (response.ok) {
          const data = await response.json();
          if (Number(data?.duration) > 0) duration = Number(data.duration) * 1000;
        }
      }
    }

    if (!duration && track.title && track.artist) {
      const query = encodeURIComponent(`track:"${track.title}" artist:"${track.artist}"`);
      const response = await fetch(`https://api.deezer.com/search?q=${query}&limit=5`);
      if (response.ok) {
        const data = await response.json();
        const wantedTitle = String(track.title).toLowerCase().trim();
        const wantedArtist = String(track.artist).toLowerCase().trim();
        const hit = (data.data || []).find(item =>
          String(item.title || "").toLowerCase().trim() === wantedTitle &&
          String(item.artist?.name || "").toLowerCase().trim() === wantedArtist &&
          Number(item.duration) > 0
        );
        if (hit) duration = Number(hit.duration) * 1000;
      }
    }
  } catch (error) {
    console.warn("Duration resolution failed", track?.id, error?.message || error);
  }

  if (duration) {
    await env.DB.prepare(`UPDATE tracks SET duration_ms=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (duration_ms IS NULL OR duration_ms=0)`)
      .bind(duration, track.id).run();
    track.duration_ms = duration;
  }

  return track;
}

async function dispatchWarm(env, trackId) {
  const existing = await env.DB.prepare(`SELECT id, created_at FROM download_jobs WHERE track_id=? AND status IN ('queued','dispatched','running') ORDER BY created_at DESC LIMIT 1`).bind(trackId).first();
  if (existing) return existing.id;

  let track = await env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(trackId).first();
  if (!track?.source_url || !env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) return null;

  track = await resolveMissingDuration(env, track);

  if (!track.duration_ms) {
    throw new Error(`Track ${track.natural_key || trackId} has no canonical duration_ms; refusing acquisition without identity data`);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO download_jobs(id,track_id,kind,status) VALUES(?,?,?,'queued')`).bind(id, trackId, "general").run();
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/acquire-audio.yml/dispatches`, {
    method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "personal-music-server", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { job_id: id, source_url: track.source_url, title: track.title, artist: track.artist || "", album: track.album || "", duration_ms: String(track.duration_ms) } }),
  });
  if (!response.ok) {
    const text = await response.text();
    await env.DB.prepare(`UPDATE download_jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(text, id).run();
    return null;
  }
  await env.DB.prepare(`UPDATE download_jobs SET status='dispatched',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
  return id;
}

async function acquireTrack(env, req, trackId) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);

  const id = Number(trackId);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "Invalid track ID" }, 400);

  const track = await env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(id).first();
  if (!track) return json({ error: "Track not found" }, 404);
  if (!track.source_url) return json({ error: "Track has no source URL to acquire from" }, 400);

  const cached = await env.DB.prepare(`SELECT drive_file_id FROM general_cache WHERE track_id=?`).bind(id).first();
  if (cached?.drive_file_id) return json({ cached: true, track_id: id, drive_file_id: cached.drive_file_id });

  try {
    const jobId = await dispatchWarm(env, id);
    if (!jobId) return json({ error: "Unable to create acquisition job" }, 502);
    return json({ cached: false, track_id: id, job_id: jobId });
  } catch (error) {
    return json({ error: String(error?.message || error) }, 502);
  }
}

async function seedLibrary(env, req, ctx) {
  if (!(await requireAuth(env, req))) return json({ error: "Unauthorized" }, 401);
  const body = await req.json();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: "No library items supplied" }, 400);
  const playlistName = String(body.playlist_name || items[0]?.playlist_name || "Playlist").trim() || "Playlist";
  const cacheItems = items.filter(x => x.cache === true || String(x.cache || "").trim().toUpperCase() === "Y");
  const matched = [], missing = [];
  for (const item of items) {
    const track = await findTrack(env, item);
    if (!track) missing.push({ title: item.title || "", artist: item.artist || "", isrc: item.isrc || "" });
    else matched.push({ item, track });
  }
  await env.DB.prepare(`UPDATE tracks SET play_count=0, updated_at=CURRENT_TIMESTAMP`).run();
  await env.DB.prepare(`DELETE FROM playlist_entries`).run();
  for (let i = 0; i < matched.length; i++) {
    const { track } = matched[i];
    await env.DB.prepare(`INSERT OR IGNORE INTO playlist_entries(track_id,position,title,artist,album,artwork_url,duration_ms) VALUES(?,?,?,?,?,?,?)`).bind(track.id, i + 1, track.title, track.artist, track.album, track.artwork_url, track.duration_ms).run();
  }
  await env.DB.prepare(`DELETE FROM top_played_cache`).run();
  const cacheMatched = [];
  for (const item of cacheItems) {
    const match = matched.find(x => x.item === item);
    const track = match?.track || await findTrack(env, item);
    if (!track || cacheMatched.some(x => x.id === track.id)) continue;
    cacheMatched.push(track);
    if (cacheMatched.length >= 200) break;
  }
  for (let i = 0; i < cacheMatched.length; i++) {
    const track = cacheMatched[i];
    const cached = await env.DB.prepare(`SELECT drive_file_id FROM general_cache WHERE track_id=?`).bind(track.id).first();
    await env.DB.prepare(`INSERT INTO top_played_cache(rank,track_id,storage_key,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)`).bind(i + 1, track.id, cached?.drive_file_id || null).run();
  }
  const warmIds = cacheMatched.map(t => t.id);
  ctx.waitUntil((async () => {
    const concurrency = 6;
    for (let i = 0; i < warmIds.length; i += concurrency) {
      await Promise.all(warmIds.slice(i, i + concurrency).map(id => dispatchWarm(env, id).catch(() => null)));
    }
  })());
  return json({ ok: true, playlist: playlistName, playlist_entries: matched.length, cache_entries: cacheMatched.length, cache_limit: 200, missing: missing.slice(0, 100), missing_count: missing.length, play_counts_reset: true });
}

async function acquisitionStatus(env, req) {
  if (!(await requireAuth(env, req))) return json({ error: "Unauthorized" }, 401);
  const { results = [] } = await env.DB.prepare(`
    SELECT j.id, j.status, j.error, j.created_at, j.updated_at,
           t.id AS track_id, t.title, t.artist, t.album
    FROM download_jobs j JOIN tracks t ON t.id=j.track_id
    ORDER BY CASE WHEN j.status IN ('queued','dispatched','running') THEN 0 ELSE 1 END, COALESCE(j.updated_at,j.created_at) DESC
    LIMIT 100
  `).all();
  return json({ jobs: results });
}

async function exportPlaylist(env, req) {
  if (!(await requireAuth(env, req))) return json({ error: "Unauthorized" }, 401);
  const { results = [] } = await env.DB.prepare(`SELECT p.position, p.track_id, p.title, p.artist, p.album, t.isrc, t.source, t.source_id, p.duration_ms, p.added_at FROM playlist_entries p JOIN tracks t ON t.id=p.track_id ORDER BY p.position ASC`).all();
  return new Response(excelWorkbook(results), { status: 200, headers: { "content-type": "application/vnd.ms-excel; charset=utf-8", "content-disposition": 'attachment; filename="dakshmusic-playlist.xls"', "cache-control": "no-store" } });
}

export async function handleLibraryRoute(req, env, ctx) {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/v1/")) return null;
  const acquireMatch = url.pathname.match(/^\/api\/v1\/tracks\/([0-9]+)\/acquire$/);
  if (acquireMatch && req.method === "POST") return acquireTrack(env, req, acquireMatch[1]);
  if (url.pathname === "/api/v1/library/seed" && req.method === "POST") return seedLibrary(env, req, ctx);
  if (url.pathname === "/api/v1/jobs/status" && req.method === "GET") return acquisitionStatus(env, req);
  if (url.pathname === "/api/v1/playlist/export" && req.method === "GET") return exportPlaylist(env, req);
  return null;
}
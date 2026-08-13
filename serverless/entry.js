import worker from "./worker.js";

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

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function pbkdf2(password, saltB64) {
  if (!saltB64) throw new Error("PASSWORD_SALT is not configured");
  let normalized = saltB64.replaceAll("-", "+").replaceAll("_", "/");
  normalized += "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = Uint8Array.from(atob(normalized), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: raw, iterations: 100000, hash: "SHA-256" }, key, 256);
  return b64(new Uint8Array(bits));
}

function slug(s) {
  return String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "unknown";
}

function buildNaturalKey(title, artist, album, source, sourceId, durationMs) {
  const base = `${slug(title)}-${slug(artist)}-${slug(album || "unknown")}`;
  const identity = sourceId ? `${slug(source || "source")}-${slug(sourceId)}` : `duration-${Math.max(0, Number(durationMs) || 0)}`;
  return `${base}-${identity}`;
}

async function findOrPrepareTrack(env, { source, source_id, source_url, title, artist, album, album_id, duration_ms, artwork_url }) {
  let track = source_id ? await env.DB.prepare(`SELECT * FROM tracks WHERE source=? AND source_id=?`).bind(source || "deezer", source_id).first() : null;
  if (!track) {
    track = await env.DB.prepare(`SELECT * FROM tracks WHERE LOWER(title)=LOWER(?) AND LOWER(artist)=LOWER(?) AND LOWER(COALESCE(album,''))=LOWER(COALESCE(?, '')) AND (duration_ms IS NULL OR ? IS NULL OR ABS(duration_ms-?)<=5000) LIMIT 1`)
      .bind(title, artist || "", album || "", duration_ms || null, duration_ms || null).first();
  }
  if (track) return track;
  const naturalKey = buildNaturalKey(title, artist, album, source, source_id, duration_ms);
  const created = await env.DB.prepare(`INSERT INTO tracks(source,source_id,source_url,title,artist,album,album_id,duration_ms,artwork_url,natural_key) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(source || "deezer", source_id || null, source_url || null, title, artist || "", album || null, album_id || null, duration_ms || null, artwork_url || null, naturalKey).run();
  return env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(created.meta.last_row_id).first();
}

async function ensureTopCache(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS top_played_cache (rank INTEGER PRIMARY KEY, track_id INTEGER NOT NULL UNIQUE, storage_key TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
}

async function refreshTopPlayed(env) {
  await ensureTopCache(env);
  const { results } = await env.DB.prepare(`SELECT id FROM tracks ORDER BY play_count DESC, id ASC LIMIT 200`).all();
  await env.DB.prepare(`DELETE FROM top_played_cache`).run();
  for (let i = 0; i < results.length; i++) {
    const cached = await env.DB.prepare(`SELECT drive_file_id FROM general_cache WHERE track_id=?`).bind(results[i].id).first();
    await env.DB.prepare(`INSERT INTO top_played_cache(rank,track_id,storage_key,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)`).bind(i + 1, results[i].id, cached?.drive_file_id || null).run();
  }
  return results;
}

async function resolveAppleDuration(env, track, trackId) {
  if (track.duration_ms && Number(track.duration_ms) > 0) return track;
  const source = String(track.source || "").toLowerCase();
  let catalogId = String(track.source_id || "").trim().replace(/^apple[-_:]/i, "");
  if (source !== "apple" && !/^\d+$/.test(catalogId)) return track;
  if (!/^\d+$/.test(catalogId)) return track;
  try {
    const lookup = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(catalogId)}&entity=song`, { headers: { Accept: "application/json", "User-Agent": "dakshmusic3-worker" } });
    if (!lookup.ok) return track;
    const data = await lookup.json();
    const song = (data.results || []).find(x => x.wrapperType === "track" && Number(x.trackTimeMillis) > 0);
    if (!song) return track;
    track.duration_ms = Number(song.trackTimeMillis);
    await env.DB.prepare(`UPDATE tracks SET duration_ms=? WHERE id=? AND (duration_ms IS NULL OR duration_ms=0)`).bind(track.duration_ms, trackId).run();
  } catch (e) { console.warn("Apple duration lookup failed", track.source_id, e); }
  return track;
}

async function resolveDeezerDuration(env, track, trackId) {
  if (track.duration_ms && Number(track.duration_ms) > 0) return track;
  let id = String(track.source_id || "").trim();
  const m = String(track.source_url || "").match(/deezer\.com\/track\/(\d+)/i);
  if (!/^\d+$/.test(id) && m) id = m[1];
  try {
    let item = null;
    if (/^\d+$/.test(id)) {
      const r = await fetch(`https://api.deezer.com/track/${encodeURIComponent(id)}`);
      if (r.ok) item = await r.json();
    }
    if (!item || item.error) {
      const q = encodeURIComponent(`track:"${track.title || ""}" artist:"${track.artist || ""}"`);
      const r = await fetch(`https://api.deezer.com/search?q=${q}&limit=10`);
      if (r.ok) {
        const d = await r.json();
        item = (d.data || []).find(x => String(x.title || "").toLowerCase() === String(track.title || "").toLowerCase() && String(x.artist?.name || "").toLowerCase() === String(track.artist || "").toLowerCase()) || d.data?.[0];
      }
    }
    if (item?.duration) {
      track.duration_ms = Number(item.duration) * 1000;
      await env.DB.prepare(`UPDATE tracks SET duration_ms=? WHERE id=? AND (duration_ms IS NULL OR duration_ms=0)`).bind(track.duration_ms, trackId).run();
    }
  } catch (e) { console.warn("Deezer duration lookup failed", track.source_id, e); }
  return track;
}

async function dispatchWarm(env, trackId, kind = "general") {
  const existing = await env.DB.prepare(`SELECT id,created_at FROM download_jobs WHERE track_id=? AND status IN ('queued','dispatched','running') ORDER BY created_at DESC LIMIT 1`).bind(trackId).first();
  if (existing) return existing.id;
  let track = await env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(trackId).first();
  if (!track?.source_url) return null;
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error("GitHub Actions dispatch is not configured");
  if (!track.duration_ms) {
    track = await resolveAppleDuration(env, track, trackId);
    if (!track.duration_ms) track = await resolveDeezerDuration(env, track, trackId);
  }
  if (!track.duration_ms) throw new Error(`Track ${track.natural_key || trackId} has no canonical duration_ms; refusing acquisition without identity data`);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO download_jobs(id,track_id,kind,status) VALUES(?,?,?,'queued')`).bind(id, trackId, kind).run();
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/acquire-audio.yml/dispatches`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "personal-music-server", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { job_id: id, source_url: track.source_url, title: track.title, artist: track.artist || "", album: track.album || "", duration_ms: String(track.duration_ms) } }),
  });
  if (!response.ok) {
    const text = await response.text();
    await env.DB.prepare(`UPDATE download_jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(text, id).run();
    throw new Error(`GitHub dispatch failed: ${response.status} ${text}`);
  }
  await env.DB.prepare(`UPDATE download_jobs SET status='dispatched',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
  return id;
}

async function listAcquisitions(env, req) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  const status = url.searchParams.get("status");
  let result;
  if (status) {
    result = await env.DB.prepare(`SELECT j.id AS job_id,j.track_id,j.kind,j.status,j.provider,j.drive_file_id,j.format,j.mime_type,j.error,j.created_at,j.updated_at,t.title,t.artist,t.album,t.artwork_url,t.duration_ms,t.source,t.source_url FROM download_jobs j LEFT JOIN tracks t ON t.id=j.track_id WHERE j.status=? ORDER BY datetime(j.created_at) DESC LIMIT ?`).bind(status, limit).all();
  } else {
    result = await env.DB.prepare(`SELECT j.id AS job_id,j.track_id,j.kind,j.status,j.provider,j.drive_file_id,j.format,j.mime_type,j.error,j.created_at,j.updated_at,t.title,t.artist,t.album,t.artwork_url,t.duration_ms,t.source,t.source_url FROM download_jobs j LEFT JOIN tracks t ON t.id=j.track_id ORDER BY datetime(j.created_at) DESC LIMIT ?`).bind(limit).all();
  }
  return json({ items: result.results || [], limit });
}

async function acquisitionSummary(env, req) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
  const result = await env.DB.prepare(`SELECT status,COUNT(*) AS count FROM download_jobs GROUP BY status`).all();
  const counts = {};
  for (const row of result.results || []) counts[row.status] = Number(row.count || 0);
  return json({ counts, active: (counts.queued || 0) + (counts.dispatched || 0) + (counts.running || 0) });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if ((path === "/api/v1/acquisitions" || path === "/api/v1/jobs") && req.method === "GET") return listAcquisitions(env, req);
    if (path === "/api/v1/acquisitions/summary" && req.method === "GET") return acquisitionSummary(env, req);
    const acquireMatch = path.match(/^\/api\/v1\/tracks\/([0-9]+)\/acquire$/);
    if (acquireMatch && req.method === "POST") {
      if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
      try {
        const jobId = await dispatchWarm(env, Number(acquireMatch[1]));
        return json({ cached: false, job_id: jobId });
      } catch (e) { return json({ error: String(e?.message || e) }, 502); }
    }
    return worker.fetch(req, env, ctx);
  },
};

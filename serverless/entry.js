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
  return String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "unknown";
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function buildNaturalKey(title, artist, album, dateStr) {
  return `${slug(title)}-${slug(artist)}-${slug(album || "unknown")}-${dateStr}`;
}

async function findOrPrepareTrack(env, { source, source_id, source_url, title, artist, album, album_id, duration_ms, artwork_url }) {
  let track = source_id ? await env.DB.prepare(`SELECT * FROM tracks WHERE source_id=?`).bind(source_id).first() : null;
  if (!track) {
    track = await env.DB.prepare(`SELECT * FROM tracks WHERE LOWER(title)=LOWER(?) AND LOWER(artist)=LOWER(?) AND LOWER(COALESCE(album,''))=LOWER(COALESCE(?,'')) LIMIT 1`)
      .bind(title, artist || "", album || "").first();
  }
  if (track) return track;

  const naturalKey = buildNaturalKey(title, artist, album, todayDate());
  const created = await env.DB.prepare(`INSERT INTO tracks(source,source_id,source_url,title,artist,album,album_id,duration_ms,artwork_url,natural_key) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(source || "deezer", source_id || null, source_url || null, title, artist || "", album || null, album_id || null, duration_ms || null, artwork_url || null, naturalKey).run();
  return await env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(created.meta.last_row_id).first();
}

async function ensureTopCache(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS top_played_cache (rank INTEGER PRIMARY KEY, track_id INTEGER NOT NULL UNIQUE, storage_key TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
}

async function refreshTopPlayed(env) {
  await ensureTopCache(env);
  const old = await env.DB.prepare(`SELECT track_id, storage_key FROM top_played_cache`).all();
  const oldKeys = new Map((old.results || []).map(r => [Number(r.track_id), r.storage_key]));
  const { results } = await env.DB.prepare(`SELECT id FROM tracks ORDER BY play_count DESC, id ASC LIMIT 100`).all();
  await env.DB.prepare(`DELETE FROM top_played_cache`).run();
  for (let i = 0; i < results.length; i++) {
    const cached = await env.DB.prepare(`SELECT drive_file_id FROM general_cache WHERE track_id=?`).bind(results[i].id).first();
    const storage = cached?.drive_file_id || oldKeys.get(Number(results[i].id)) || null;
    await env.DB.prepare(`INSERT INTO top_played_cache(rank,track_id,storage_key,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)`).bind(i + 1, results[i].id, storage).run();
  }
  return results;
}

async function dispatchWarm(env, trackId) {
  const existing = await env.DB.prepare(`SELECT id, created_at FROM download_jobs WHERE track_id=? AND kind='general' AND status IN ('queued','dispatched','running') ORDER BY created_at DESC LIMIT 1`).bind(trackId).first();
  if (existing) {
    const ageMs = Date.now() - new Date(existing.created_at.replace(" ", "T") + "Z").getTime();
    if (ageMs < 20 * 60 * 1000) return existing.id;
    await env.DB.prepare(`UPDATE download_jobs SET status='failed',error='Timed out waiting for the acquisition workflow',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(existing.id).run();
  }
  const track = await env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(trackId).first();
  if (!track?.source_url) return null;
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error("GitHub Actions dispatch is not configured");
  if (!track.duration_ms) throw new Error(`Track ${trackId} has no canonical duration_ms; refusing acquisition without identity data`);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO download_jobs(id,track_id,kind,status) VALUES(?,?,'general','queued')`).bind(id, trackId).run();
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/acquire-audio.yml/dispatches`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "personal-music-server", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: {
      job_id: id,
      source_url: track.source_url,
      title: track.title,
      artist: track.artist || "",
      album: track.album || "",
      duration_ms: String(track.duration_ms),
    } }),
  });
  if (!response.ok) {
    const text = await response.text();
    await env.DB.prepare(`UPDATE download_jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(text, id).run();
    throw new Error(`GitHub dispatch failed: ${response.status} ${text}`);
  }
  await env.DB.prepare(`UPDATE download_jobs SET status='dispatched',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
  return id;
}

async function warmWorkingCache(env, ctx) {
  const top = await refreshTopPlayed(env);
  const current = await env.DB.prepare(`SELECT track_id FROM general_cache ORDER BY last_accessed_at DESC`).all();
  const ids = new Set((current.results || []).map(r => Number(r.track_id)));
  const candidates = top.map(r => Number(r.id)).filter(id => !ids.has(id)).slice(0, 25);
  const immediate = candidates.slice(0, 5);
  const backload = candidates.slice(5, 25);
  const warmOne = async id => {
    const row = await env.DB.prepare(`SELECT storage_key FROM top_played_cache WHERE track_id=?`).bind(id).first();
    if (row?.storage_key && env.AUDIO_BUCKET) {
      const object = await env.AUDIO_BUCKET.head(row.storage_key);
      if (object) {
        await env.DB.prepare(`INSERT OR REPLACE INTO general_cache(track_id,drive_file_id,last_accessed_at) VALUES(?,?,CURRENT_TIMESTAMP)`).bind(id, row.storage_key).run();
        return;
      }
    }
    try { await dispatchWarm(env, id); } catch (e) { console.error("Working-cache warm failed", id, e); }
  };
  for (const id of immediate) await warmOne(id);
  if (backload.length) ctx.waitUntil((async () => { for (const id of backload) await warmOne(id); })());
  return { top100: top.length, immediate: immediate.length, backload: backload.length };
}

async function uploadAudio(env, req, jobId) {
  const supplied = req.headers.get("X-Callback-Secret");
  if (!supplied || supplied !== env.CALLBACK_SECRET) return json({ error: "Unauthorized" }, 401);
  const job = await env.DB.prepare(`SELECT * FROM download_jobs WHERE id=?`).bind(jobId).first();
  if (!job) return json({ error: "Job not found" }, 404);
  const track = await env.DB.prepare(`SELECT natural_key FROM tracks WHERE id=?`).bind(job.track_id).first();
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider") || null;
  const format = url.searchParams.get("format") || "flac";
  const contentType = req.headers.get("content-type") || (format === "mp3" ? "audio/mpeg" : "audio/flac");
  const storageKey = `${track?.natural_key || `track-${job.track_id}`}.${format}`;
  await env.AUDIO_BUCKET.put(storageKey, req.body, { httpMetadata: { contentType } });
  await env.DB.prepare(`UPDATE download_jobs SET status='complete',provider=?,drive_file_id=?,format=?,mime_type=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(provider, storageKey, format, contentType, jobId).run();
  await ensureTopCache(env);
  await env.DB.prepare(`UPDATE top_played_cache SET storage_key=?,updated_at=CURRENT_TIMESTAMP WHERE track_id=?`).bind(storageKey, job.track_id).run();
  if (job.kind === "general") {
    await env.DB.prepare(`INSERT OR REPLACE INTO general_cache(track_id,drive_file_id,last_accessed_at) VALUES(?,?,CURRENT_TIMESTAMP)`).bind(job.track_id, storageKey).run();
    const keep = Math.max(1, Number.parseInt(env.GENERAL_CACHE_LIMIT || "25", 10) || 25);
    const old = await env.DB.prepare(`SELECT id,track_id,drive_file_id FROM general_cache ORDER BY last_accessed_at DESC LIMIT -1 OFFSET ?`).bind(keep).all();
    for (const row of old.results || []) {
      await env.DB.prepare(`DELETE FROM general_cache WHERE id=?`).bind(row.id).run();
      const protectedRow = await env.DB.prepare(`SELECT 1 FROM top_played_cache WHERE track_id=?`).bind(row.track_id).first();
      if (!protectedRow && row.drive_file_id) {
        try { await env.AUDIO_BUCKET.delete(row.drive_file_id); } catch (e) { console.error("R2 eviction failed", row.drive_file_id, e); }
      }
    }
  }
  return json({ ok: true, storage_key: storageKey });
}

function norm(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

async function deezerSearch(title, artist) {
  const url = new URL("https://api.deezer.com/search");
  url.searchParams.set("q", `${title} ${artist}`);
  url.searchParams.set("limit", "10");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Deezer HTTP ${response.status}`);
  const data = await response.json();
  const wantTitle = norm(title), wantArtist = norm(artist);
  const scored = (data.data || []).map(x => {
    const t = norm(x.title), a = norm(x.artist?.name);
    let score = 0;
    if (t === wantTitle) score += 3;
    else if (t.includes(wantTitle) || wantTitle.includes(t)) score += 1;
    if (a === wantArtist) score += 3;
    else if (a.includes(wantArtist) || wantArtist.includes(a)) score += 1;
    return { x, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score >= 4 ? scored[0].x : null;
}

async function appleImport(env, req, ctx) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) return json({ error: "No Apple Music tracks supplied" }, 400);
  await ensureTopCache(env);
  const sorted = items.map(x => ({ ...x, play_count: Number(x.play_count || 0) })).sort((a, b) => b.play_count - a.play_count).slice(0, 100);
  const matched = [], unmatched = [];
  for (const item of sorted) {
    try {
      const found = await deezerSearch(item.title, item.artist);
      if (!found) { unmatched.push({ title: item.title, artist: item.artist }); continue; }
      const track = await findOrPrepareTrack(env, {
        source: "deezer",
        source_id: String(found.id),
        source_url: found.link,
        title: found.title,
        artist: found.artist?.name || item.artist || "",
        album: found.album?.title || item.album || null,
        album_id: found.album?.id ? String(found.album.id) : null,
        duration_ms: (found.duration || 0) * 1000,
        artwork_url: found.album?.cover_xl || found.album?.cover_big || null,
      });
      const importedCount = Math.max(0, item.play_count);
      await env.DB.prepare(`UPDATE tracks SET play_count=MAX(play_count,?),updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(importedCount, track.id).run();
      matched.push({ track_id: track.id, title: track.title, artist: track.artist, play_count: importedCount });
    } catch (e) {
      unmatched.push({ title: item.title, artist: item.artist, error: String(e?.message || e) });
    }
  }
  await refreshTopPlayed(env);
  const top = await env.DB.prepare(`SELECT track_id,storage_key FROM top_played_cache ORDER BY rank LIMIT 100`).all();
  const missing = (top.results || []).filter(r => !r.storage_key).map(r => Number(r.track_id));
  ctx.waitUntil((async () => { for (const id of missing) { try { await dispatchWarm(env, id); } catch (e) { console.error("Top-100 acquisition dispatch failed", id, e); } } })());
  let warm = { top100: 0, immediate: 0, backload: 0 };
  try { warm = await warmWorkingCache(env, ctx); } catch (e) { console.error("Post-import warm failed", e); }
  return json({ imported: items.length, matched: matched.length, unmatched, top100: matched.length, queued: missing.length, warm });
}

async function callback(env, req) {
  const supplied = req.headers.get("X-Callback-Secret");
  if (!supplied || supplied !== env.CALLBACK_SECRET) return json({ error: "Unauthorized" }, 401);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!body?.job_id) return json({ error: "job_id is required" }, 400);
  const job = await env.DB.prepare(`SELECT * FROM download_jobs WHERE id=?`).bind(body.job_id).first();
  if (!job) return json({ error: "Job not found" }, 404);
  await env.DB.prepare(`UPDATE download_jobs SET status=?,provider=COALESCE(?,provider),drive_file_id=COALESCE(?,drive_file_id),format=COALESCE(?,format),mime_type=COALESCE(?,mime_type),error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(body.status || "complete", body.provider || null, body.r2_key || body.drive_file_id || null, body.format || null, body.mime_type || null, body.error || null, body.job_id).run();
  return json({ ok: true });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const audioUploadMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/audio$/);
    if (audioUploadMatch && (req.method === "PUT" || req.method === "POST")) return uploadAudio(env, req, audioUploadMatch[1]);
    if (url.pathname === "/api/v1/jobs/callback" && req.method === "POST") return callback(env, req);
    if (url.pathname === "/api/v1/cache/top/rebuild" && req.method === "POST") {
      if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
      const top = await refreshTopPlayed(env);
      return json({ top100: top.length });
    }
    if (url.pathname === "/api/v1/cache/top" && req.method === "GET") {
      if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
      await ensureTopCache(env);
      const result = await env.DB.prepare(`SELECT c.rank,c.track_id,t.title,t.artist,t.album,t.play_count,c.storage_key FROM top_played_cache c JOIN tracks t ON t.id=c.track_id ORDER BY c.rank LIMIT 100`).all();
      return json({ limit: 100, items: result.results || [] });
    }
    if (url.pathname === "/api/v1/integrations/apple-music/import" && req.method === "POST") return appleImport(env, req, ctx);
    return worker.fetch(req, env, ctx);
  },
};

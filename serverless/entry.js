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

function buildNaturalKey(title, artist, album, source, sourceId, durationMs) {
  const base = `${slug(title)}-${slug(artist)}-${slug(album || "unknown")}`;
  const identity = sourceId ? `${slug(source || "source")}-${slug(sourceId)}` : `duration-${Math.max(0, Number(durationMs) || 0)}`;
  return `${base}-${identity}`;
}

async function findOrPrepareTrack(env, { source, source_id, source_url, title, artist, album, album_id, duration_ms, artwork_url }) {
  let track = source_id
    ? await env.DB.prepare(`SELECT * FROM tracks WHERE source=? AND source_id=?`).bind(source || "deezer", source_id).first()
    : null;
  if (!track) {
    track = await env.DB.prepare(`SELECT * FROM tracks WHERE LOWER(title)=LOWER(?) AND LOWER(artist)=LOWER(?) AND LOWER(COALESCE(album,''))=LOWER(COALESCE(?,'')) AND (duration_ms IS NULL OR ? IS NULL OR ABS(duration_ms-?)<=5000) LIMIT 1`)
      .bind(title, artist || "", album || "", duration_ms || null, duration_ms || null).first();
  }
  if (track) return track;

  const naturalKey = buildNaturalKey(title, artist, album, source, source_id, duration_ms);
  const created = await env.DB.prepare(`INSERT INTO tracks(source,source_id,source_url,title,artist,album,album_id,duration_ms,artwork_url,natural_key) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(source || "deezer", source_id || null, source_url || null, title, artist || "", album || null, album_id || null, duration_ms || null, artwork_url || null, naturalKey).run();
  return await env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(created.meta.last_row_id).first();
}

async function upsertLightAlbum(env, { source_id, title, artist, artwork_url, tracks_count }) {
  if (!source_id) return;
  await env.DB.prepare(`
    INSERT INTO albums (source, source_id, title, artist, artwork_url, tracks_count)
    VALUES ('deezer', ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      title=excluded.title, artist=excluded.artist,
      artwork_url=COALESCE(albums.artwork_url, excluded.artwork_url),
      tracks_count=COALESCE(albums.tracks_count, excluded.tracks_count),
      updated_at=CURRENT_TIMESTAMP
  `).bind(source_id, title || null, artist || null, artwork_url || null, tracks_count || null).run();
}

async function upsertRichAlbum(env, data) {
  const genre = data.genres?.data?.[0]?.name || null;
  const artwork = data.cover_xl || data.cover_big || data.cover_medium || null;
  await env.DB.prepare(`
    INSERT INTO albums (source, source_id, title, artist, artwork_url, release_date, genre, tracks_count)
    VALUES ('deezer', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      title=excluded.title, artist=excluded.artist, artwork_url=excluded.artwork_url,
      release_date=excluded.release_date, genre=excluded.genre, tracks_count=excluded.tracks_count,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    String(data.id), data.title || null, data.artist?.name || null, artwork,
    data.release_date || null, genre, data.nb_tracks || null
  ).run();
}

async function ensureTopCache(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS top_played_cache (rank INTEGER PRIMARY KEY, track_id INTEGER NOT NULL UNIQUE, storage_key TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
}

async function refreshTopPlayed(env) {
  await ensureTopCache(env);
  const old = await env.DB.prepare(`SELECT track_id, storage_key FROM top_played_cache`).all();
  const oldKeys = new Map((old.results || []).map(r => [Number(r.track_id), r.storage_key]));
  const { results } = await env.DB.prepare(`SELECT id FROM tracks ORDER BY play_count DESC, id ASC LIMIT 200`).all();
  await env.DB.prepare(`DELETE FROM top_played_cache`).run();
  for (let i = 0; i < results.length; i++) {
    const cached = await env.DB.prepare(`SELECT drive_file_id FROM general_cache WHERE track_id=?`).bind(results[i].id).first();
    const storage = cached?.drive_file_id || oldKeys.get(Number(results[i].id)) || null;
    await env.DB.prepare(`INSERT INTO top_played_cache(rank,track_id,storage_key,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)`).bind(i + 1, results[i].id, storage).run();
  }
  return results;
}

async function dispatchWarm(env, trackId, kind = "general") {
  const existing = await env.DB.prepare(`SELECT id, created_at FROM download_jobs WHERE track_id=? AND status IN ('queued','dispatched','running') ORDER BY created_at DESC LIMIT 1`).bind(trackId).first();
  if (existing) {
    const ageMs = Date.now() - new Date(existing.created_at.replace(" ", "T") + "Z").getTime();
    if (ageMs < 20 * 60 * 1000) return existing.id;
    await env.DB.prepare(`UPDATE download_jobs SET status='failed',error='Timed out waiting for the acquisition workflow',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(existing.id).run();
  }
  const track = await env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(trackId).first();
  if (!track?.source_url) return null;
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error("GitHub Actions dispatch is not configured");
  if (!track.duration_ms) throw new Error(`Track ${track.natural_key || trackId} has no canonical duration_ms; refusing acquisition without identity data`);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO download_jobs(id,track_id,kind,status) VALUES(?,?,?,'queued')`).bind(id, trackId, kind).run();
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
    try { await dispatchWarm(env, id); } catch (e) {
      const t = await env.DB.prepare(`SELECT natural_key FROM tracks WHERE id=?`).bind(id).first();
      console.error("Working-cache warm failed", t?.natural_key || id, e);
    }
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
  if (!["queued", "dispatched", "running"].includes(job.status)) return json({ error: `Job is not uploadable from status ${job.status}` }, 409);

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider") || null;
  const format = (url.searchParams.get("format") || "flac").toLowerCase();
  if (!["flac", "mp3"].includes(format)) return json({ error: "Unsupported audio format" }, 400);
  const contentType = req.headers.get("content-type") || (format === "mp3" ? "audio/mpeg" : "audio/flac");
  if (!contentType.startsWith("audio/")) return json({ error: "Invalid audio content type" }, 400);
  const contentLength = Number(req.headers.get("content-length") || 0);
  const maxUploadBytes = Math.max(1, Number.parseInt(env.MAX_UPLOAD_BYTES || "104857600", 10) || 104857600);
  if (contentLength && contentLength > maxUploadBytes) return json({ error: "Audio upload exceeds configured size limit" }, 413);

  const claimed = await env.DB.prepare(`UPDATE download_jobs SET status='running',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','dispatched','running')`).bind(jobId).run();
  if (!claimed.meta?.changes) return json({ error: "Job is no longer accepting uploads" }, 409);

  const track = await env.DB.prepare(`SELECT natural_key FROM tracks WHERE id=?`).bind(job.track_id).first();
  const storageKey = `${track?.natural_key || `track-${job.track_id}`}.${format}`;
  try {
    await env.AUDIO_BUCKET.put(storageKey, req.body, { httpMetadata: { contentType } });
    await env.DB.prepare(`UPDATE download_jobs SET status='complete',provider=?,drive_file_id=?,format=?,mime_type=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'`).bind(provider, storageKey, format, contentType, jobId).run();
  } catch (e) {
    await env.DB.prepare(`UPDATE download_jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'`).bind(String(e?.message || e), jobId).run();
    throw e;
  }

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
  await env.DB.prepare(`UPDATE album_cache SET status='complete',drive_file_id=?,last_accessed_at=CURRENT_TIMESTAMP WHERE track_id=?`).bind(storageKey, job.track_id).run();
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
  ctx.waitUntil((async () => { for (const id of missing) { try { await dispatchWarm(env, id); } catch (e) { const t = await env.DB.prepare(`SELECT natural_key FROM tracks WHERE id=?`).bind(id).first(); console.error("Top-100 acquisition dispatch failed", t?.natural_key || id, e); } } })());
  let warm = { top100: 0, immediate: 0, backload: 0 };
  try { warm = await warmWorkingCache(env, ctx); } catch (e) { console.error("Post-import warm failed", e); }
  return json({ imported: matched.length, matched: matched.length, unmatched, top100: matched.slice(0, 100), queued: missing.length, warm });
}

async function addPlaylistEntry(env, body) {
  if (!body?.title) return json({ error: "Track title is required" }, 400);
  if (body.album_id) {
    try {
      await upsertLightAlbum(env, {
        source_id: body.album_id,
        title: body.album || null,
        artist: body.artist || null,
        artwork_url: body.artwork_url || null,
      });
    } catch (e) { console.error("Album upsert failed (playlist add)", body.album_id, e); }
  }
  const track = await findOrPrepareTrack(env, body);

  const existingEntry = await env.DB.prepare(`SELECT id, position FROM playlist_entries WHERE track_id=?`).bind(track.id).first();
  if (existingEntry) {
    return json({ track_id: track.id, position: existingEntry.position, entry_id: existingEntry.id, already_present: true });
  }

  const pos = await env.DB.prepare(`SELECT COALESCE(MAX(position),0)+1 AS p FROM playlist_entries`).first();
  const inserted = await env.DB.prepare(`
    INSERT INTO playlist_entries(track_id,position,title,artist,album,artwork_url,duration_ms)
    VALUES(?,?,?,?,?,?,?)
  `).bind(track.id, pos?.p || 1, track.title, track.artist, track.album, track.artwork_url, track.duration_ms).run();

  let jobId = null;
  try { jobId = await dispatchWarm(env, track.id); } catch (e) { console.error("Playlist-add acquisition dispatch failed", track.natural_key || track.id, e); }

  return json({ track_id: track.id, position: pos?.p || 1, entry_id: inserted.meta.last_row_id, already_present: false, job_id: jobId }, 201);
}

async function playlistMutation(env, req, entryId) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
  const id = Number(entryId);
  if (req.method === "DELETE") {
    const row = await env.DB.prepare(`SELECT position FROM playlist_entries WHERE id=?`).bind(id).first();
    if (!row) return json({ error: "Playlist entry not found" }, 404);
    await env.DB.prepare(`DELETE FROM playlist_entries WHERE id=?`).bind(id).run();
    await env.DB.prepare(`UPDATE playlist_entries SET position=position-1 WHERE position>?`).bind(row.position).run();
    return json({ ok: true });
  }
  let body; try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const row = await env.DB.prepare(`SELECT position FROM playlist_entries WHERE id=?`).bind(id).first();
  if (!row) return json({ error: "Playlist entry not found" }, 404);
  const count = Number((await env.DB.prepare(`SELECT COUNT(*) AS count FROM playlist_entries`).first())?.count || 0);
  const target = Math.min(count, Math.max(1, Number.parseInt(body.position, 10) || 1));
  if (target < row.position) await env.DB.prepare(`UPDATE playlist_entries SET position=position+1 WHERE position>=? AND position<?`).bind(target, row.position).run();
  else if (target > row.position) await env.DB.prepare(`UPDATE playlist_entries SET position=position-1 WHERE position>? AND position<=?`).bind(row.position, target).run();
  await env.DB.prepare(`UPDATE playlist_entries SET position=? WHERE id=?`).bind(target, id).run();
  return json({ ok: true, position: target });
}

async function listStoredAlbums(env, req) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
  const { results } = await env.DB.prepare(`
    SELECT
      s.id AS session_id,
      s.source_album_id AS album_id,
      s.name AS title,
      s.artist,
      s.created_at,
      s.last_accessed_at,
      (SELECT COUNT(*) FROM album_cache c WHERE c.session_id = s.id) AS total_tracks,
      (SELECT COUNT(*) FROM album_cache c WHERE c.session_id = s.id AND c.status = 'complete') AS ready_tracks
    FROM album_sessions s
    ORDER BY s.last_accessed_at DESC
  `).all();
  return json({ items: results || [] });
}

async function albumSearch(env, req) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  if (!q) return json({ error: "q is required" }, 400);
  const dz = new URL("https://api.deezer.com/search/album");
  dz.searchParams.set("q", q);
  dz.searchParams.set("limit", "25");
  const response = await fetch(dz);
  if (!response.ok) return json({ error: `Deezer HTTP ${response.status}` }, 502);
  const data = await response.json();
  const items = (data.data || []).map(x => ({
    album_id: String(x.id),
    title: x.title,
    artist: x.artist?.name || null,
    artwork_url: x.cover_xl || x.cover_big || x.cover_medium || null,
    tracks_count: x.nb_tracks || null,
  }));
  for (const it of items) {
    try { await upsertLightAlbum(env, { source_id: it.album_id, ...it }); }
    catch (e) { console.error("Album upsert failed", it.album_id, e); }
  }
  return json({ items });
}

async function cacheWholeAlbum(env, albumId, name, artist, trackIds) {
  const limit = Math.max(1, Number.parseInt(env.MAX_ALBUM_SESSIONS || "5", 10) || 5);

  let session = await env.DB.prepare(`SELECT id FROM album_sessions WHERE source_album_id=?`).bind(albumId).first();
  if (!session) {
    const sessionId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO album_sessions(id,source_album_id,name,artist) VALUES(?,?,?,?)`)
      .bind(sessionId, albumId, name || "Unknown Album", artist || null).run();
    session = { id: sessionId };

    const old = await env.DB.prepare(`SELECT id FROM album_sessions ORDER BY last_accessed_at DESC LIMIT -1 OFFSET ?`).bind(limit).all();
    for (const row of old.results || []) {
      const tracks = await env.DB.prepare(`SELECT drive_file_id FROM album_cache WHERE session_id=?`).bind(row.id).all();
      for (const t of tracks.results || []) {
        if (!t.drive_file_id) continue;
        const protectedRow = await env.DB.prepare(`
          SELECT 1 FROM general_cache WHERE drive_file_id=?
          UNION SELECT 1 FROM top_played_cache WHERE storage_key=?
        `).bind(t.drive_file_id, t.drive_file_id).first();
        if (!protectedRow) {
          try { await env.AUDIO_BUCKET.delete(t.drive_file_id); } catch (e) { console.error("Album cache R2 eviction failed", t.drive_file_id, e); }
        }
      }
      await env.DB.prepare(`DELETE FROM album_sessions WHERE id=?`).bind(row.id).run();
    }
  } else {
    await env.DB.prepare(`UPDATE album_sessions SET last_accessed_at=CURRENT_TIMESTAMP WHERE id=?`).bind(session.id).run();
  }

  await Promise.all(trackIds.map(async (trackId) => {
    const existingRow = await env.DB.prepare(`SELECT drive_file_id FROM album_cache WHERE session_id=? AND track_id=?`).bind(session.id, trackId).first();
    if (existingRow?.drive_file_id) return;

    const alreadyCached = await env.DB.prepare(`SELECT drive_file_id FROM general_cache WHERE track_id=?`).bind(trackId).first();
    if (alreadyCached?.drive_file_id) {
      await env.DB.prepare(`INSERT OR REPLACE INTO album_cache(session_id,track_id,status,drive_file_id,last_accessed_at) VALUES(?,?,'complete',?,CURRENT_TIMESTAMP)`)
        .bind(session.id, trackId, alreadyCached.drive_file_id).run();
      return;
    }

    await env.DB.prepare(`INSERT OR REPLACE INTO album_cache(session_id,track_id,status,last_accessed_at) VALUES(?,?,'queued',CURRENT_TIMESTAMP)`)
      .bind(session.id, trackId).run();
    try { await dispatchWarm(env, trackId, "album"); }
    catch (e) {
      const t = await env.DB.prepare(`SELECT natural_key FROM tracks WHERE id=?`).bind(trackId).first();
      console.error("Album cache acquisition dispatch failed", t?.natural_key || trackId, e);
      await env.DB.prepare(`UPDATE album_cache SET status='failed' WHERE session_id=? AND track_id=?`).bind(session.id, trackId).run();
    }
  }));
}

async function albumDetail(env, req, albumId, ctx) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
  const response = await fetch(`https://api.deezer.com/album/${encodeURIComponent(albumId)}`);
  if (!response.ok) return json({ error: `Deezer HTTP ${response.status}` }, 502);
  const data = await response.json();
  if (data.error) return json({ error: data.error.message || "Album not found" }, 404);
  const artwork = data.cover_xl || data.cover_big || data.cover_medium || null;
  try { await upsertRichAlbum(env, data); } catch (e) { console.error("Rich album upsert failed", albumId, e); }

  const rawTracks = (data.tracks?.data || []).map(x => ({
    source: "deezer",
    source_id: String(x.id),
    source_url: x.link,
    title: x.title,
    artist: x.artist?.name || data.artist?.name || null,
    album: data.title,
    album_id: String(data.id),
    duration_ms: (x.duration || 0) * 1000,
    artwork_url: artwork,
  }));

  const tracks = [];
  for (const rt of rawTracks) {
    try {
      const track = await findOrPrepareTrack(env, rt);
      tracks.push({ ...rt, id: track.id });
    } catch (e) {
      console.error("Failed to resolve album track", rt.source_id, e);
      tracks.push({ ...rt, id: null });
    }
  }

  const validTrackIds = tracks.map(t => t.id).filter(id => id != null);
  if (validTrackIds.length && ctx) {
    ctx.waitUntil(
      cacheWholeAlbum(env, String(data.id), data.title, data.artist?.name || null, validTrackIds)
        .catch(e => console.error("Whole-album caching failed", albumId, e))
    );
  }

  return json({
    album_id: String(data.id),
    title: data.title,
    artist: data.artist?.name || null,
    artwork_url: artwork,
    release_date: data.release_date || null,
    tracks,
  });
}

async function acquireTrack(env, req, trackId) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
  const id = Number(trackId);
  const cached = await env.DB.prepare(`SELECT drive_file_id FROM general_cache WHERE track_id=?`).bind(id).first();
  if (cached?.drive_file_id) return json({ cached: true });
  try {
    const jobId = await dispatchWarm(env, id);
    if (!jobId) return json({ error: "Track has no source URL to acquire from" }, 400);
    return json({ cached: false, job_id: jobId });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 502);
  }
}

async function clearAllData(env, req) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const password = String(body?.password || "");
  if (!password) return json({ error: "Password is required" }, 400);
  if (!env.PASSWORD_HASH || !env.PASSWORD_SALT) return json({ error: "Authentication is not configured" }, 500);

  let actual;
  try { actual = await pbkdf2(password, env.PASSWORD_SALT); }
  catch (e) { console.error("Password verification failed", e); return json({ error: "Password verification failed" }, 500); }
  if (actual !== env.PASSWORD_HASH) return json({ error: "Invalid password" }, 401);

  const keys = new Set();
  for (const table of ["general_cache", "top_played_cache", "album_cache"]) {
    const col = table === "top_played_cache" ? "storage_key" : "drive_file_id";
    try {
      const { results } = await env.DB.prepare(`SELECT ${col} AS k FROM ${table} WHERE ${col} IS NOT NULL`).all();
      for (const r of results || []) if (r.k) keys.add(r.k);
    } catch (e) { console.error("Failed to collect R2 keys from", table, e); }
  }

  const tables = [
    "album_cache", "album_sessions", "general_cache", "top_played_cache",
    "download_jobs", "playlist_entries", "albums", "tracks",
  ];
  for (const table of tables) {
    try { await env.DB.prepare(`DELETE FROM ${table}`).run(); }
    catch (e) { console.error("Failed to clear table", table, e); }
  }

  let r2Deleted = 0, r2Failed = 0;
  for (const key of keys) {
    try { await env.AUDIO_BUCKET.delete(key); r2Deleted++; }
    catch (e) { r2Failed++; console.error("Failed to delete R2 object during clear-all", key, e); }
  }

  return json({ ok: true, cleared: true, r2_objects_deleted: r2Deleted, r2_objects_failed: r2Failed });
}

async function callback(env, req) {
  const supplied = req.headers.get("X-Callback-Secret");
  if (!supplied || supplied !== env.CALLBACK_SECRET) return json({ error: "Unauthorized" }, 401);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!body?.job_id) return json({ error: "job_id is required" }, 400);
  const job = await env.DB.prepare(`SELECT * FROM download_jobs WHERE id=?`).bind(body.job_id).first();
  if (!job) return json({ error: "Job not found" }, 404);
  const nextStatus = body.status || "complete";
  if (!["failed", "complete"].includes(nextStatus)) return json({ error: "Invalid callback status" }, 400);
  if (!["queued", "dispatched", "running"].includes(job.status)) return json({ error: `Job is already terminal: ${job.status}` }, 409);
  const result = await env.DB.prepare(`UPDATE download_jobs SET status=?,provider=COALESCE(?,provider),drive_file_id=COALESCE(?,drive_file_id),format=COALESCE(?,format),mime_type=COALESCE(?,mime_type),error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','dispatched','running')`)
    .bind(nextStatus, body.provider || null, body.r2_key || body.drive_file_id || null, body.format || null, body.mime_type || null, body.error || null, body.job_id).run();
  if (!result.meta?.changes) return json({ error: "Job state changed before callback was accepted" }, 409);
  return json({ ok: true });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    const audioUploadMatch = path.match(/^\/api\/v1\/jobs\/([^/]+)\/audio$/);
    if (audioUploadMatch && (req.method === "PUT" || req.method === "POST")) return uploadAudio(env, req, audioUploadMatch[1]);
    if (path === "/api/v1/jobs/callback" && req.method === "POST") return callback(env, req);

    if (path === "/api/v1/cache/top/rebuild" && req.method === "POST") {
      if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
      const top = await refreshTopPlayed(env);
      return json({ top100: top.length });
    }
    if (path === "/api/v1/cache/top" && req.method === "GET") {
      if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
      await ensureTopCache(env);
      const result = await env.DB.prepare(`SELECT c.rank,c.track_id,t.title,t.artist,t.album,t.play_count,c.storage_key FROM top_played_cache c JOIN tracks t ON t.id=c.track_id ORDER BY c.rank LIMIT 100`).all();
      return json({ limit: 100, items: result.results || [] });
    }

    if (path === "/api/v1/apple-music/import" && req.method === "POST") return appleImport(env, req, ctx);

    if (path === "/api/v1/albums/search" && req.method === "GET") return albumSearch(env, req);
    if (path === "/api/v1/albums/stored" && req.method === "GET") return listStoredAlbums(env, req);
    const albumMatch = path.match(/^\/api\/v1\/albums\/([^/]+)$/);
    if (albumMatch && req.method === "GET") return albumDetail(env, req, albumMatch[1], ctx);

    const acquireMatch = path.match(/^\/api\/v1\/tracks\/([0-9]+)\/acquire$/);
    if (acquireMatch && req.method === "POST") return acquireTrack(env, req, acquireMatch[1]);

    if (path === "/api/v1/admin/clear-all" && req.method === "POST") return clearAllData(env, req);

    if (path === "/api/v1/playlist" && req.method === "POST") {
      if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
      let body; try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
      return addPlaylistEntry(env, body);
    }

    const entryMatch = path.match(/^\/api\/v1\/playlist\/([0-9]+)$/);
    if (entryMatch && (req.method === "DELETE" || req.method === "PATCH")) return playlistMutation(env, req, entryMatch[1]);

    if (path === "/api/v1/playlist" && req.method === "DELETE") {
      if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
      await env.DB.prepare(`DELETE FROM playlist_entries`).run();
      return json({ ok: true });
    }

    if (path === "/api/v1/playlist" && req.method === "GET") {
      const response = await worker.fetch(req, env, ctx);
      if (response.ok) ctx.waitUntil(warmWorkingCache(env, ctx).catch(e => console.error("Cache warm failed", e)));
      return response;
    }

    if (path.startsWith("/api/v1/playback/") && req.method === "GET") {
      const response = await worker.fetch(req, env, ctx);
      if (response.ok) ctx.waitUntil(refreshTopPlayed(env).catch(e => console.error("Top-played refresh failed", e)));
      return response;
    }

    return worker.fetch(req, env, ctx);
  },
};

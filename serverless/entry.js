import worker from "./worker.js";

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extra,
    },
  });

function cookie(req) {
  const value = req.headers.get("Cookie") || "";
  const match = value.match(/(?:^|;\s*)music_session=([^;]+)/);
  return match?.[1] || null;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function requireAuth(env, req) {
  const token = cookie(req);
  if (!token || !env.DB) return false;
  const idHash = await sha256(token);
  const row = await env.DB.prepare(`SELECT id_hash FROM sessions WHERE id_hash = ? AND expires_at > ?`)
    .bind(idHash, Math.floor(Date.now() / 1000)).first();
  return !!row;
}

async function uploadAudio(env, req, jobId) {
  const supplied = req.headers.get("X-Callback-Secret");
  if (!supplied || supplied !== env.CALLBACK_SECRET) return json({ error: "Unauthorized" }, 401);
  if (!env.DB) return json({ error: "Database is not configured" }, 500);
  if (!env.AUDIO_BUCKET) return json({ error: "R2 storage is not configured" }, 500);

  const job = await env.DB.prepare(`SELECT * FROM download_jobs WHERE id = ?`).bind(jobId).first();
  if (!job) return json({ error: "Job not found" }, 404);

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider") || null;
  const format = url.searchParams.get("format") || "flac";
  const contentType = req.headers.get("content-type") || (format === "mp3" ? "audio/mpeg" : "audio/flac");
  const storageKey = `tracks/${job.track_id}.${format}`;

  await env.AUDIO_BUCKET.put(storageKey, req.body, { httpMetadata: { contentType } });
  await env.DB.prepare(`
    UPDATE download_jobs SET status='complete', provider=?, drive_file_id=?, format=?, mime_type=?, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).bind(provider, storageKey, format, contentType, jobId).run();

  if (job.kind === "general") {
    await env.DB.prepare(`INSERT OR REPLACE INTO general_cache(track_id, drive_file_id, last_accessed_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
      .bind(job.track_id, storageKey).run();

    const keep = Math.max(1, Number.parseInt(env.GENERAL_CACHE_LIMIT || "25", 10) || 25);
    const old = await env.DB.prepare(`SELECT id, drive_file_id FROM general_cache ORDER BY last_accessed_at DESC LIMIT -1 OFFSET ?`)
      .bind(keep).all();

    for (const row of old.results || []) {
      await env.DB.prepare(`DELETE FROM general_cache WHERE id=?`).bind(row.id).run();
      if (row.drive_file_id) {
        try { await env.AUDIO_BUCKET.delete(row.drive_file_id); } catch (e) { console.error("R2 eviction failed", e); }
      }
    }
  }

  return json({ ok: true, storage_key: storageKey });
}

async function ensureTopCache(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS top_played_cache (
      rank INTEGER PRIMARY KEY,
      track_id INTEGER NOT NULL UNIQUE,
      storage_key TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function refreshTopPlayed(env) {
  await ensureTopCache(env);
  const { results } = await env.DB.prepare(`SELECT id FROM tracks ORDER BY play_count DESC, id ASC LIMIT 100`).all();
  await env.DB.prepare(`DELETE FROM top_played_cache`).run();

  for (let i = 0; i < results.length; i++) {
    const cached = await env.DB.prepare(`SELECT drive_file_id FROM general_cache WHERE track_id=?`)
      .bind(results[i].id).first();
    await env.DB.prepare(`INSERT INTO top_played_cache(rank, track_id, storage_key, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`)
      .bind(i + 1, results[i].id, cached?.drive_file_id || null).run();
  }

  return results;
}

async function dispatchTopWarm(env, trackId) {
  const active = await env.DB.prepare(`
    SELECT id FROM download_jobs WHERE track_id=? AND kind='general'
      AND status IN ('queued','dispatched','running') ORDER BY created_at DESC LIMIT 1
  `).bind(trackId).first();
  if (active) return { queued: false, job_id: active.id };

  const track = await env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(trackId).first();
  if (!track || !track.source_url) return { queued: false, reason: "missing source" };

  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO download_jobs(id, track_id, kind, status) VALUES (?, ?, 'general', 'queued')`).bind(id, trackId).run();

  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    throw new Error("GitHub Actions dispatch is not configured");
  }

  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/acquire-audio.yml/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "personal-music-server",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        job_id: id,
        source_url: track.source_url || "",
        title: track.title || "",
        artist: track.artist || "",
        album: track.album || "",
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    await env.DB.prepare(`UPDATE download_jobs SET status='failed', error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(text, id).run();
    throw new Error(`GitHub dispatch failed: ${response.status} ${text}`);
  }

  await env.DB.prepare(`UPDATE download_jobs SET status='dispatched', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
  return { queued: true, job_id: id };
}

async function warmWorkingCache(env, ctx) {
  const top = await refreshTopPlayed(env);
  const working = await env.DB.prepare(`SELECT track_id FROM general_cache`).all();
  const workingIds = new Set((working.results || []).map((x) => Number(x.track_id)));
  const candidates = top.map((x) => Number(x.id)).filter((id) => !workingIds.has(id)).slice(0, 25);

  const immediate = candidates.slice(0, 5);
  const backload = candidates.slice(5, 25);

  for (const id of immediate) {
    try { await dispatchTopWarm(env, id); } catch (e) { console.error("Immediate cache warm failed", id, e); }
  }

  if (backload.length) {
    ctx.waitUntil((async () => {
      for (const id of backload) {
        try { await dispatchTopWarm(env, id); } catch (e) { console.error("Backload cache warm failed", id, e); }
      }
    })());
  }

  return { top_played_count: top.length, immediate: immediate.length, backload: backload.length };
}

async function addPlaylistEntry(env, body) {
  if (!body?.title) return json({ error: "Track title is required" }, 400);

  let track = null;
  if (body.source_id) track = await env.DB.prepare(`SELECT * FROM tracks WHERE source_id=?`).bind(body.source_id).first();

  if (!track) {
    const result = await env.DB.prepare(`
      INSERT INTO tracks(source, source_id, source_url, title, artist, album, album_id, duration_ms, artwork_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.source || "deezer", body.source_id || null, body.source_url || null,
      body.title, body.artist || null, body.album || null, body.album_id || null,
      body.duration_ms || null, body.artwork_url || null
    ).run();
    track = await env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(result.meta.last_row_id).first();
  }

  const pos = await env.DB.prepare(`SELECT COALESCE(MAX(position),0)+1 AS p FROM playlist_entries`).first();
  const position = pos?.p || 1;
  await env.DB.prepare(`INSERT INTO playlist_entries(track_id, position) VALUES (?, ?)`).bind(track.id, position).run();
  return json({ track_id: track.id, position }, 201);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    const audioUploadMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/audio$/);
    if (audioUploadMatch && (req.method === "PUT" || req.method === "POST")) {
      return uploadAudio(env, req, audioUploadMatch[1]);
    }

    if (url.pathname === "/api/v1/playlist" && req.method === "POST") {
      const authCheck = await worker.fetch(new Request(url.toString(), { method: "GET", headers: req.headers }), env, ctx);
      if (authCheck.status === 401) return authCheck;
      if (!authCheck.ok) return authCheck;
      let body;
      try { body = await req.clone().json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
      return addPlaylistEntry(env, body);
    }

    if (url.pathname === "/api/v1/playlist" && req.method === "GET") {
      const response = await worker.fetch(req, env, ctx);
      if (response.ok) {
        try { await warmWorkingCache(env, ctx); } catch (e) { console.error("Cache warm failed", e); }
      }
      return response;
    }

    if (url.pathname.startsWith("/api/v1/playback/") && req.method === "GET") {
      const response = await worker.fetch(req, env, ctx);
      if (response.ok) ctx.waitUntil(refreshTopPlayed(env).catch((e) => console.error("Top-played refresh failed", e)));
      return response;
    }

    if (url.pathname === "/api/v1/cache/top" && req.method === "GET") {
      if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
      const tracks = await refreshTopPlayed(env);
      return json({ count: tracks.length, items: tracks });
    }

    return worker.fetch(req, env, ctx);
  },
};

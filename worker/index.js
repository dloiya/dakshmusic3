const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function response(request, data, status = 200) {
  return json(data, status, corsHeaders(request));
}

function error(request, message, status = 400) {
  return response(request, { error: message }, status);
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function now() {
  return new Date().toISOString();
}

function normalizeTrack(input) {
  if (!input || typeof input !== "object") throw new Error("track is required");

  const required = ["title", "artist", "source", "source_id", "source_url"];
  for (const key of required) {
    if (!input[key]) throw new Error(`track.${key} is required`);
  }

  return {
    title: String(input.title).trim(),
    artist: String(input.artist).trim(),
    album_id: input.album_id == null ? null : Number(input.album_id),
    album_name: input.album_name == null ? null : String(input.album_name),
    source: String(input.source),
    source_id: String(input.source_id),
    source_url: String(input.source_url),
    isrc: input.isrc == null ? null : String(input.isrc),
    duration_ms: input.duration_ms == null ? null : Number(input.duration_ms),
    artwork_url: input.artwork_url == null ? null : String(input.artwork_url),
    metadata_json:
      input.metadata_json == null
        ? null
        : JSON.stringify(input.metadata_json),
  };
}

async function getOrCreateTrack(db, t) {
  const existing = await db
    .prepare(
      `SELECT id FROM tracks
       WHERE source = ? AND source_id = ?
       LIMIT 1`
    )
    .bind(t.source, t.source_id)
    .first();

  if (existing) {
    await db
      .prepare(
        `UPDATE tracks
         SET title = ?, artist = ?, album_id = ?, album_name = ?,
             source_url = ?, isrc = ?, duration_ms = ?, artwork_url = ?,
             metadata_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        t.title,
        t.artist,
        t.album_id,
        t.album_name,
        t.source_url,
        t.isrc,
        t.duration_ms,
        t.artwork_url,
        t.metadata_json,
        now(),
        existing.id
      )
      .run();

    return Number(existing.id);
  }

  const result = await db
    .prepare(
      `INSERT INTO tracks
       (title, artist, album_id, album_name, source, source_id, source_url,
        isrc, duration_ms, artwork_url, storage_status, play_count,
        cache_requested, created_at, updated_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing', 0, 0, ?, ?, ?)`
    )
    .bind(
      t.title,
      t.artist,
      t.album_id,
      t.album_name,
      t.source,
      t.source_id,
      t.source_url,
      t.isrc,
      t.duration_ms,
      t.artwork_url,
      now(),
      now(),
      t.metadata_json
    )
    .run();

  return Number(result.meta.last_row_id);
}

async function queueState(db, queueKey) {
  return (
    (await db
      .prepare(
        `SELECT queue_key, current_index, mode, shuffle_enabled, updated_at
         FROM queue_state WHERE queue_key = ?`
      )
      .bind(queueKey)
      .first()) || {
      queue_key: queueKey,
      current_index: 0,
      mode: "playlist",
      shuffle_enabled: 1,
      updated_at: null,
    }
  );
}

async function ensureQueueState(db, queueKey) {
  const t = now();
  await db
    .prepare(
      `INSERT INTO queue_state
       (queue_key, current_index, mode, shuffle_enabled, updated_at)
       VALUES (?, 0, 'playlist', 1, ?)
       ON CONFLICT(queue_key) DO NOTHING`
    )
    .bind(queueKey, t)
    .run();
}

async function queueRows(db, queueKey) {
  const result = await db
    .prepare(
      `SELECT
         q.id AS queue_entry_id,
         q.position,
         t.id,
         t.title,
         t.artist,
         t.album_id,
         t.album_name,
         t.source,
         t.source_id,
         t.source_url,
         t.artwork_url,
         t.duration_ms,
         t.storage_key,
         t.storage_status,
         t.play_count
       FROM queue_entries q
       JOIN tracks t ON t.id = q.track_id
       WHERE q.queue_key = ?
       ORDER BY q.position ASC`
    )
    .bind(queueKey)
    .all();

  return result.results || [];
}

async function initializeQueue(db, queueKey) {
  const existing = await queueRows(db, queueKey);
  if (existing.length > 0) {
    return { created: false, count: existing.length };
  }

  const hot = await db
    .prepare(
      `SELECT id FROM tracks
       WHERE storage_status IS NOT NULL
       ORDER BY play_count DESC, RANDOM()
       LIMIT 50`
    )
    .all();

  const selected = [];
  const seen = new Set();

  for (const row of hot.results || []) {
    if (selected.length >= 5) break;
    const id = Number(row.id);
    if (!seen.has(id)) {
      selected.push(id);
      seen.add(id);
    }
  }

  const catalog = await db
    .prepare(
      `SELECT id FROM tracks
       WHERE id NOT IN (
         SELECT id FROM tracks
         WHERE id IN (${selected.length ? selected.map(() => "?").join(",") : "NULL"})
       )
       ORDER BY RANDOM()
       LIMIT 15`
    )
    .bind(...selected)
    .all();

  for (const row of catalog.results || []) {
    if (selected.length >= 20) break;
    const id = Number(row.id);
    if (!seen.has(id)) {
      selected.push(id);
      seen.add(id);
    }
  }

  if (selected.length === 0) {
    throw new Error("Track catalog is empty");
  }

  const t = now();

  await db
    .prepare(
      `INSERT INTO queue_state
       (queue_key, current_index, mode, shuffle_enabled, updated_at)
       VALUES (?, 0, 'playlist', 1, ?)
       ON CONFLICT(queue_key) DO UPDATE SET updated_at = excluded.updated_at`
    )
    .bind(queueKey, t)
    .run();

  for (let i = 0; i < selected.length; i++) {
    await db
      .prepare(
        `INSERT INTO queue_entries
         (queue_key, track_id, position, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(queueKey, selected[i], i, t, t)
      .run();
  }

  return { created: true, count: selected.length };
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  if (path === "/api/health" && method === "GET") {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      return response(request, { ok: true, service: "dakshmusic3-queue" });
    } catch (e) {
      return error(request, `D1 unavailable: ${e.message}`, 503);
    }
  }

  const queueKey =
    url.searchParams.get("queue_key") ||
    env.DEFAULT_QUEUE_KEY ||
    "default";

  try {
    if (path === "/api/queue" && method === "GET") {
      const state = await queueState(env.DB, queueKey);
      const tracks = await queueRows(env.DB, queueKey);
      return response(request, { queue_key: queueKey, state, tracks });
    }

    if (path === "/api/queue/initialize" && method === "POST") {
      const body = await bodyJson(request);
      const key = body.queue_key || queueKey;
      const result = await initializeQueue(env.DB, key);
      return response(request, {
        queue_key: key,
        ...result,
      });
    }

    if (path === "/api/queue/add" && method === "POST") {
      const body = await bodyJson(request);
      const key = body.queue_key || queueKey;
      const t = normalizeTrack(body.track);
      const trackId = await getOrCreateTrack(env.DB, t);

      // Production D1 has a foreign-key relationship from queue_entries to
      // queue_state. Make sure the parent queue row exists before inserting
      // the child entry. This is especially important for a brand-new queue.
      await ensureQueueState(env.DB, key);

      const duplicate = await env.DB
        .prepare(
          `SELECT id, position FROM queue_entries
           WHERE queue_key = ? AND track_id = ? LIMIT 1`
        )
        .bind(key, trackId)
        .first();

      if (duplicate) {
        return response(request, {
          ok: true,
          track_id: trackId,
          queue_entry_id: Number(duplicate.id),
          position: Number(duplicate.position),
          duplicate: true,
        });
      }

      const max = await env.DB
        .prepare(
          `SELECT COALESCE(MAX(position), -1) AS max_position
           FROM queue_entries WHERE queue_key = ?`
        )
        .bind(key)
        .first();

      const position = Number(max?.max_position ?? -1) + 1;
      const tnow = now();

      const inserted = await env.DB
        .prepare(
          `INSERT INTO queue_entries
           (queue_key, track_id, position, added_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(key, trackId, position, tnow, tnow)
        .run();

      return response(request, {
        ok: true,
        track_id: trackId,
        queue_entry_id: Number(inserted.meta.last_row_id),
        position,
      });
    }

    const removeMatch = path.match(/^\/api\/queue\/(\d+)$/);
    if (removeMatch && method === "DELETE") {
      const entryId = Number(removeMatch[1]);
      await env.DB
        .prepare(`DELETE FROM queue_entries WHERE id = ?`)
        .bind(entryId)
        .run();

      return response(request, { ok: true });
    }

    if (path === "/api/queue/next" && method === "POST") {
      const state = await queueState(env.DB, queueKey);
      const rows = await queueRows(env.DB, queueKey);
      const next =
        rows.length === 0 ? 0 : (Number(state.current_index) + 1) % rows.length;

      await env.DB
        .prepare(
          `INSERT INTO queue_state
           (queue_key, current_index, mode, shuffle_enabled, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(queue_key) DO UPDATE SET
             current_index = excluded.current_index,
             mode = excluded.mode,
             shuffle_enabled = excluded.shuffle_enabled,
             updated_at = excluded.updated_at`
        )
        .bind(
          queueKey,
          next,
          state.mode || "playlist",
          Number(state.shuffle_enabled ?? 1),
          now()
        )
        .run();

      return response(request, { ok: true, current_index: next });
    }

    if (path === "/api/queue/shuffle" && method === "POST") {
      const body = await bodyJson(request);
      const enabled = body.enabled ? 1 : 0;
      const state = await queueState(env.DB, queueKey);

      await env.DB
        .prepare(
          `INSERT INTO queue_state
           (queue_key, current_index, mode, shuffle_enabled, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(queue_key) DO UPDATE SET
             shuffle_enabled = excluded.shuffle_enabled,
             updated_at = excluded.updated_at`
        )
        .bind(
          queueKey,
          Number(state.current_index || 0),
          state.mode || "playlist",
          enabled,
          now()
        )
        .run();

      return response(request, {
        ok: true,
        shuffle_enabled: enabled,
      });
    }

    if (path === "/api/acquisition" && method === "GET") {
      const limit = Math.min(
        Math.max(Number(url.searchParams.get("limit") || 20), 1),
        100
      );

      const result = await env.DB
        .prepare(
          `SELECT
             a.id, a.track_id, a.status, a.worker, a.attempts, a.error,
             a.created_at, a.updated_at, a.started_at, a.completed_at,
             t.title, t.artist, t.source_url
           FROM acquisition_jobs a
           JOIN tracks t ON t.id = a.track_id
           ORDER BY a.created_at DESC
           LIMIT ?`
        )
        .bind(limit)
        .all();

      return response(request, { jobs: result.results || [] });
    }

    if (path === "/api/acquisition" && method === "POST") {
      const body = await bodyJson(request);
      const trackId = Number(body.track_id);
      if (!trackId) return error(request, "track_id is required");

      const track = await env.DB
        .prepare(`SELECT id, source_url FROM tracks WHERE id = ?`)
        .bind(trackId)
        .first();

      if (!track) return error(request, "Track not found", 404);

      const active = await env.DB
        .prepare(
          `SELECT id, status FROM acquisition_jobs
           WHERE track_id = ? AND status IN ('queued','running')
           ORDER BY created_at DESC LIMIT 1`
        )
        .bind(trackId)
        .first();

      if (active) {
        return response(request, {
          ok: true,
          job_id: active.id,
          status: active.status,
          duplicate: true,
        });
      }

      const id = crypto.randomUUID();
      await env.DB
        .prepare(
          `INSERT INTO acquisition_jobs
           (id, track_id, status, worker, attempts, error, created_at, updated_at)
           VALUES (?, ?, 'queued', NULL, 0, NULL, ?, ?)`
        )
        .bind(id, trackId, now(), now())
        .run();

      return response(request, {
        ok: true,
        job_id: id,
        status: "queued",
        source_url: track.source_url,
      }, 202);
    }

    return error(request, "Not found", 404);
  } catch (e) {
    console.error(e);
    return error(request, e?.message || "Internal error", 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/") || request.method !== "GET") {
      return handle(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

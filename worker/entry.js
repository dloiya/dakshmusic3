import router from "./router.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const now = () => new Date().toISOString();

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...(request ? corsHeaders(request) : {}) },
  });
}

function error(request, message, status = 400) {
  return json({ error: message }, status, request);
}

async function queueAcquisition(env, trackId, priority = "normal") {
  const track = await env.DB.prepare(
    `SELECT id, title, artist, album_name, source_url, storage_key, storage_status
     FROM tracks WHERE id = ?`
  ).bind(Number(trackId)).first();

  if (!track) return null;
  if (track.storage_status === "ready" && track.storage_key) {
    return { ready: true, track_id: Number(track.id) };
  }

  const active = await env.DB.prepare(
    `SELECT id, status FROM acquisition_jobs
     WHERE track_id = ? AND status IN ('queued','running')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(Number(trackId)).first();

  if (active) {
    return { job_id: active.id, status: active.status, duplicate: true };
  }

  const id = crypto.randomUUID();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO acquisition_jobs
     (id, track_id, status, worker, attempts, error, created_at, updated_at, started_at)
     VALUES (?, ?, 'queued', 'queue', 0, NULL, ?, ?, NULL)`
  ).bind(id, Number(trackId), t, t).run();

  await env.METADATA_QUEUE.send({
    type: "acquisition",
    job_id: id,
    track_id: Number(track.id),
    priority,
  });

  return { job_id: id, status: "queued", track_id: Number(track.id), priority };
}

async function queueRows(env, key) {
  const result = await env.DB.prepare(
    `SELECT q.id AS queue_entry_id, q.position,
            t.id, t.title, t.artist, t.album_id, t.album_name,
            t.source, t.source_id, t.source_url, t.artwork_url,
            t.duration_ms, t.storage_key, t.storage_status, t.play_count,
            t.metadata_json
     FROM queue_entries q
     JOIN tracks t ON t.id = q.track_id
     WHERE q.queue_key = ?
     ORDER BY q.position`
  ).bind(key).all();
  return result.results || [];
}

async function clearQueue(env, key) {
  await env.DB.prepare(`DELETE FROM queue_entries WHERE queue_key = ?`).bind(key).run();
}

async function setPlaybackMode(env, mode) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO queue_state(queue_key,current_index,mode,shuffle_enabled,updated_at)
     VALUES('default',0,?,1,?)
     ON CONFLICT(queue_key) DO UPDATE SET
       current_index=0, mode=excluded.mode, updated_at=excluded.updated_at`
  ).bind(mode, t).run();
}

async function appendQueue(env, key, tracks) {
  const max = await env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) AS p FROM queue_entries WHERE queue_key = ?`
  ).bind(key).first();
  let position = Number(max?.p ?? -1) + 1;
  const t = now();
  for (const track of tracks) {
    await env.DB.prepare(
      `INSERT INTO queue_entries(queue_key,track_id,position,added_at,updated_at)
       VALUES(?,?,?,?,?)`
    ).bind(key, Number(track.id), position++, t, t).run();
  }
}

async function buildTrackQueue(env, selected) {
  const tracks = [selected];
  const seen = new Set([Number(selected.id)]);

  if (selected.album_id) {
    const album = await env.DB.prepare(
      `SELECT id,title,artist,album_id,album_name,source,source_id,source_url,
              artwork_url,duration_ms,storage_key,storage_status,play_count,metadata_json
       FROM tracks WHERE album_id = ? ORDER BY id`
    ).bind(Number(selected.album_id)).all();

    for (const row of album.results || []) {
      if (!seen.has(Number(row.id))) {
        tracks.push(row);
        seen.add(Number(row.id));
      }
    }
  }

  if (tracks.length === 1 && selected.artist) {
    const artist = await env.DB.prepare(
      `SELECT id,title,artist,album_id,album_name,source,source_id,source_url,
              artwork_url,duration_ms,storage_key,storage_status,play_count,metadata_json
       FROM tracks
       WHERE lower(artist) = lower(?) AND id != ?
       ORDER BY play_count DESC, storage_status = 'ready' DESC, RANDOM()
       LIMIT 10`
    ).bind(String(selected.artist), Number(selected.id)).all();

    for (const row of artist.results || []) {
      if (!seen.has(Number(row.id))) {
        tracks.push(row);
        seen.add(Number(row.id));
      }
    }
  }

  return tracks;
}

async function handlePlayTrack(request, env, ctx) {
  const body = await request.json();
  const id = Number(body.track_id);
  if (!id) return error(request, "track_id is required");

  const selected = await env.DB.prepare(
    `SELECT id,title,artist,album_id,album_name,source,source_id,source_url,
            artwork_url,duration_ms,storage_key,storage_status,play_count,metadata_json
     FROM tracks WHERE id = ?`
  ).bind(id).first();
  if (!selected) return error(request, "Track not found", 404);

  await clearQueue(env, "album-current");
  await clearQueue(env, "default");
  await setPlaybackMode(env, "track");

  await env.DB.prepare(
    `UPDATE tracks SET play_count=COALESCE(play_count,0)+1,updated_at=? WHERE id=?`
  ).bind(now(), id).run();

  const queue = await buildTrackQueue(env, selected);
  await appendQueue(env, "default", queue);

  const jobs = [];
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].storage_status !== "ready") {
      jobs.push(await queueAcquisition(env, queue[i].id, i === 0 ? "high" : "normal"));
    }
  }

  return json({
    ok: true,
    mode: "track",
    current_index: 0,
    track: selected,
    tracks: await queueRows(env, "default"),
    acquisition_jobs: jobs,
  }, 200, request);
}

async function handlePlayAlbum(request, env, albumId) {
  const rows = await env.DB.prepare(
    `SELECT id,title,artist,album_id,album_name,source,source_id,source_url,
            artwork_url,duration_ms,storage_key,storage_status,play_count,metadata_json
     FROM tracks WHERE album_id = ? ORDER BY id`
  ).bind(Number(albumId)).all();
  const tracks = rows.results || [];
  if (!tracks.length) return error(request, "Album not found", 404);

  await clearQueue(env, "default");
  await clearQueue(env, "album-current");
  await setPlaybackMode(env, "album");

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS album_play_history
     (id INTEGER PRIMARY KEY AUTOINCREMENT, album_id INTEGER NOT NULL,
      album_name TEXT, artist TEXT, artwork_url TEXT, played_at TEXT NOT NULL)`
  ).run();

  const t = now();
  await env.DB.prepare(
    `INSERT INTO album_play_history(album_id,album_name,artist,artwork_url,played_at)
     VALUES(?,?,?,?,?)`
  ).bind(Number(albumId), tracks[0].album_name, tracks[0].artist, tracks[0].artwork_url, t).run();
  await env.DB.prepare(
    `DELETE FROM album_play_history
     WHERE id NOT IN (SELECT id FROM album_play_history ORDER BY played_at DESC LIMIT 5)`
  ).run();

  for (let i = 0; i < tracks.length; i++) {
    await env.DB.prepare(
      `INSERT INTO queue_entries(queue_key,track_id,position,added_at,updated_at)
       VALUES('album-current',?,?,?,?)`
    ).bind(Number(tracks[i].id), i, t, t).run();
  }

  const jobs = [];
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].storage_status !== "ready") {
      jobs.push(await queueAcquisition(env, tracks[i].id, i === 0 ? "high" : "normal"));
    }
  }

  return json({
    ok: true,
    mode: "album",
    album_id: Number(albumId),
    current_index: 0,
    tracks: await queueRows(env, "album-current"),
    acquisition_jobs: jobs,
  }, 200, request);
}

async function handleAcquisition(request, env) {
  const body = await request.json();
  const id = Number(body.track_id);
  if (!id) return error(request, "track_id is required");
  const result = await queueAcquisition(env, id, body.priority || "normal");
  if (!result) return error(request, "Track not found", 404);
  return json({ ok: true, ...result }, 202, request);
}

async function processAcquisitionMessage(message, env) {
  const body = message.body || {};
  if (body.type !== "acquisition") return false;

  const jobId = String(body.job_id || "");
  const trackId = Number(body.track_id);
  if (!jobId || !trackId) throw new Error("Invalid acquisition queue message");

  const track = await env.DB.prepare(
    `SELECT id,title,artist,album_name,source_url,storage_key,storage_status
     FROM tracks WHERE id = ?`
  ).bind(trackId).first();
  if (!track) throw new Error(`Track ${trackId} not found`);

  await env.DB.prepare(
    `UPDATE acquisition_jobs
     SET status='running', worker='oci', attempts=attempts+1,
         started_at=COALESCE(started_at,?), updated_at=?, error=NULL
     WHERE id=?`
  ).bind(now(), now(), jobId).run();

  const base = String(env.OCI_API_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("OCI_API_URL is not configured");
  if (!env.OCI_API_TOKEN) throw new Error("OCI_API_TOKEN is not configured");

  const encoded = encodeURIComponent(String(track.source_url));
  const acquireUrl = `${base}/acquire/${encoded}`;
  console.log("[ACQUIRE] calling OCI:", acquireUrl);

  const upstream = await fetch(acquireUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OCI_API_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      job_id: jobId,
      track_id: trackId,
      source_url: track.source_url,
      title: track.title,
      artist: track.artist,
      album_name: track.album_name || null,
      priority: body.priority || "normal",
    }),
  });

  const text = await upstream.text();
  console.log("[ACQUIRE] OCI response:", upstream.status, text);

  let data = {};
  try { data = JSON.parse(text); } catch { data = { detail: text }; }

  if (!upstream.ok) {
    throw new Error(data?.detail || data?.error || `OCI retriever returned HTTP ${upstream.status}`);
  }

  const storageKey = data.storage_key || data.key || data.r2_key || null;
  const returnedStatus = String(data.status || "").toLowerCase();
  const completed = !!storageKey || ["ready", "completed", "complete", "success"].includes(returnedStatus);

  if (completed) {
    await env.DB.prepare(
      `UPDATE acquisition_jobs
       SET status='completed',updated_at=?,completed_at=?,error=NULL WHERE id=?`
    ).bind(now(), now(), jobId).run();
    await env.DB.prepare(
      `UPDATE tracks SET storage_key=COALESCE(?,storage_key),storage_status='ready',
       cache_requested=1,updated_at=? WHERE id=?`
    ).bind(storageKey ? String(storageKey) : null, now(), trackId).run();
  } else {
    await env.DB.prepare(
      `UPDATE acquisition_jobs SET status='running',updated_at=?,error=NULL WHERE id=?`
    ).bind(now(), jobId).run();
    await env.DB.prepare(
      `UPDATE tracks SET storage_status='downloading',cache_requested=1,updated_at=? WHERE id=?`
    ).bind(now(), trackId).run();
  }

  return true;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (path === "/api/acquisition" && request.method === "POST") {
      return handleAcquisition(request, env);
    }

    if (path === "/api/play/track" && request.method === "POST") {
      return handlePlayTrack(request, env, ctx);
    }

    const albumMatch = path.match(/^\/api\/play\/album\/(\d+)$/);
    if (albumMatch && request.method === "POST") {
      return handlePlayAlbum(request, env, albumMatch[1]);
    }

    return router.fetch(request, env, ctx);
  },

  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        const handled = await processAcquisitionMessage(message, env);
        if (!handled) {
          console.log("Ignoring non-acquisition queue message:", message.body);
        }
        message.ack();
      } catch (e) {
        console.error("Acquisition queue message failed:", e);
        message.retry();
      }
    }
  },

  async scheduled(controller, env, ctx) {
    if (router.scheduled) {
      return router.scheduled(controller, env, ctx);
    }
  },
};

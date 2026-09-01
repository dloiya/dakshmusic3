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

async function processAcquisitionMessage(message, env) {
  const body = message.body || {};
  console.log("[QUEUE] received message:", JSON.stringify(body));

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

    return router.fetch(request, env, ctx);
  },

  async queue(batch, env, ctx) {
    console.log(`[QUEUE] received batch: ${batch.messages.length} message(s)`);
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

async function handleAcquisition(request, env) {
  const body = await request.json();
  const id = Number(body.track_id);
  if (!id) return error(request, "track_id is required");
  const result = await queueAcquisition(env, id, body.priority || "normal");
  if (!result) return error(request, "Track not found", 404);
  return json({ ok: true, ...result }, 202, request);
}

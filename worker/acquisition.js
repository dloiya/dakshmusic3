const now = () => new Date().toISOString();

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

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

function transientD1(err) {
  const msg = String(err?.message || err);
  return msg.includes("Network connection lost") ||
    msg.includes("storage caused object to be reset") ||
    msg.includes("reset because its code was updated");
}

async function d1(fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (attempt > 9 || !transientD1(err)) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function ensureAcquisitionJobs(db) {
  await d1(() => db.prepare(`
    CREATE TABLE IF NOT EXISTS acquisition_jobs (
      id TEXT PRIMARY KEY,
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
      worker TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      storage_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `).run());

  // Existing databases may have been created from an older version of this
  // table without priority. CREATE TABLE IF NOT EXISTS does not alter them,
  // so repair that schema in-place before any SELECT/INSERT references it.
  const columns = await d1(() => db.prepare(`PRAGMA table_info(acquisition_jobs)`).all());
  const hasPriority = (columns.results || []).some((column) => column.name === "priority");
  if (!hasPriority) {
    await d1(() => db.prepare(`
      ALTER TABLE acquisition_jobs
      ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'
    `).run());
  }

  await d1(() => db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_jobs_active_track
    ON acquisition_jobs(track_id) WHERE status IN ('queued','running')
  `).run());
  await d1(() => db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_track_created
    ON acquisition_jobs(track_id, created_at DESC)
  `).run());
}

function ociBase(env) {
  const value = String(env.OCI_API_URL || "").trim();
  if (!value) throw new Error("OCI_API_URL is not configured");
  return value.replace(/\/$/, "");
}

async function dispatchToOci(env, track, jobId, priority) {
  if (!env.OCI_API_TOKEN) throw new Error("OCI_API_TOKEN is not configured");
  const encoded = encodeURIComponent(String(track.source_url));
  const r = await fetch(`${ociBase(env)}/acquire/${encoded}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OCI_API_TOKEN}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, track_id: Number(track.id), source_url: track.source_url, title: track.title, artist: track.artist, album_name: track.album_name || null, priority }),
  });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { detail: text }; }
  return { ok: r.ok, status: r.status, data };
}

async function startJob(db, env, job, track) {
  try {
    const claimed = await d1(() => db.prepare(`
      UPDATE acquisition_jobs SET status='running',worker='oci',attempts=attempts+1,
        started_at=COALESCE(started_at,?),updated_at=?,error=NULL
      WHERE id=? AND status='queued'
    `).bind(now(), now(), job.id).run());
    if (!Number(claimed.meta?.changes || 0)) return;

    await d1(() => db.prepare(`UPDATE tracks SET storage_status='queued',cache_requested=1,updated_at=? WHERE id=?`).bind(now(), track.id).run());
    const result = await dispatchToOci(env, track, job.id, job.priority);
    if (!result.ok) throw new Error(result.data?.detail || result.data?.error || `OCI retriever returned HTTP ${result.status}`);

    const data = result.data || {};
    const storageKey = data.storage_key || data.key || data.r2_key || null;
    const returnedStatus = String(data.status || "").toLowerCase();
    const complete = !!storageKey || ["ready", "complete", "completed", "success"].includes(returnedStatus);

    if (complete) {
      const completedAt = now();
      await d1(() => db.prepare(`
        UPDATE acquisition_jobs SET status='completed',storage_key=?,updated_at=?,completed_at=?,error=NULL WHERE id=?
      `).bind(storageKey ? String(storageKey) : null, completedAt, completedAt, job.id).run());
      await d1(() => db.prepare(`
        UPDATE tracks SET storage_key=COALESCE(?,storage_key),storage_status='available',cache_requested=1,updated_at=? WHERE id=?
      `).bind(storageKey ? String(storageKey) : null, completedAt, track.id).run());
    } else {
      await d1(() => db.prepare(`UPDATE acquisition_jobs SET status='running',updated_at=?,error=NULL WHERE id=?`).bind(now(), job.id).run());
    }
  } catch (err) {
    console.error("Acquisition job failed", job.id, err);
    await d1(() => db.prepare(`UPDATE acquisition_jobs SET status='failed',error=?,updated_at=? WHERE id=?`).bind(String(err?.message || err).slice(0, 2000), now(), job.id).run()).catch((dbErr) => console.error("Failed to persist acquisition job failure", dbErr));
    await d1(() => db.prepare(`UPDATE tracks SET storage_status='failed',updated_at=? WHERE id=?`).bind(now(), track.id).run()).catch((dbErr) => console.error("Failed to persist track acquisition failure", dbErr));
  }
}

export async function enqueueAcquisition(db, env, trackId, priority = "normal", ctx = null) {
  await ensureAcquisitionJobs(db);
  const id = Number(trackId);
  const track = await d1(() => db.prepare(`SELECT id,title,artist,album_name,source_url,storage_key,storage_status FROM tracks WHERE id=?`).bind(id).first());
  if (!track) return null;
  if (track.storage_status === "available" && track.storage_key) return { ready: true, track_id: id };

  const active = await d1(() => db.prepare(`SELECT id,status,priority,attempts FROM acquisition_jobs WHERE track_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).bind(id).first());
  if (active) return { job_id: active.id, status: active.status, track_id: id, priority: active.priority, duplicate: true };

  const job = { id: crypto.randomUUID(), track_id: id, status: "queued", priority: priority === "high" ? "high" : "normal" };
  const t = now();
  try {
    await d1(() => db.prepare(`
      INSERT INTO acquisition_jobs (id,track_id,status,worker,priority,attempts,error,storage_key,created_at,updated_at,started_at,completed_at)
      VALUES(?,?, 'queued','oci',?,0,NULL,NULL,?,?,NULL,NULL)
    `).bind(job.id, id, job.priority, t, t).run());
  } catch (err) {
    if (String(err?.message || err).includes("UNIQUE")) {
      const existing = await d1(() => db.prepare(`SELECT id,status,priority FROM acquisition_jobs WHERE track_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).bind(id).first());
      if (existing) return { job_id: existing.id, status: existing.status, track_id: id, priority: existing.priority, duplicate: true };
    }
    throw err;
  }

  await d1(() => db.prepare(`UPDATE tracks SET storage_status='queued',cache_requested=1,updated_at=? WHERE id=?`).bind(t, id).run());
  const run = startJob(db, env, job, track);
  if (ctx) ctx.waitUntil(run); else await run;
  return { job_id: job.id, status: "queued", track_id: id, priority: job.priority };
}

export async function handleAcquisition(request, env, ctx) {
  try {
    const body = await request.json();
    const id = Number(body.track_id);
    if (!id) return error(request, "track_id is required");
    const result = await enqueueAcquisition(env.DB, env, id, body.priority || "normal", ctx);
    if (!result) return error(request, "Track not found", 404);
    return json({ ok: true, ...result }, 202, request);
  } catch (err) {
    console.error("Acquisition API error", err);
    if (transientD1(err)) return error(request, "Temporary database outage. Please retry.", 503);
    return error(request, String(err?.message || err), 500);
  }
}

export async function handlePlayTrack(request, env, ctx) {
  const body = await request.json();
  const id = Number(body.track_id);
  if (!id) return error(request, "track_id is required");
  const track = await d1(() => env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(id).first());
  if (!track) return error(request, "Track not found", 404);
  const t = now();
  await d1(() => env.DB.batch([
    env.DB.prepare(`DELETE FROM queue_entries WHERE queue_key IN ('default','album-current')`),
    env.DB.prepare(`INSERT INTO queue_state(queue_key,current_index,mode,shuffle_enabled,updated_at) VALUES('default',0,'track',1,?) ON CONFLICT(queue_key) DO UPDATE SET current_index=0,mode='track',updated_at=excluded.updated_at`).bind(t),
    env.DB.prepare(`UPDATE tracks SET play_count=COALESCE(play_count,0)+1,updated_at=? WHERE id=?`).bind(t,id),
    env.DB.prepare(`INSERT INTO queue_entries(queue_key,track_id,position,added_at,updated_at) VALUES('default',?,?,?,?)`).bind(id,0,t,t),
  ]));
  const acquisition = await enqueueAcquisition(env.DB, env, id, "high", ctx);
  const queue = await d1(() => env.DB.prepare(`SELECT q.id AS queue_entry_id,q.position,t.* FROM queue_entries q JOIN tracks t ON t.id=q.track_id WHERE q.queue_key='default' ORDER BY q.position`).all());
  return json({ ok:true, mode:"track", current_index:0, track, tracks:queue.results||[], acquisition },200,request);
}

export async function handlePlayAlbum(request, env, albumId, ctx) {
  const id = Number(albumId);
  const result = await d1(() => env.DB.prepare(`SELECT * FROM tracks WHERE album_id=? ORDER BY id`).bind(id).all());
  const tracks = result.results || [];
  if (!tracks.length) return error(request, "Album not found", 404);
  const t = now();
  const statements = [
    env.DB.prepare(`DELETE FROM queue_entries WHERE queue_key IN ('default','album-current')`),
    env.DB.prepare(`INSERT INTO queue_state(queue_key,current_index,mode,shuffle_enabled,updated_at) VALUES('album-current',0,'album',1,?) ON CONFLICT(queue_key) DO UPDATE SET current_index=0,mode='album',updated_at=excluded.updated_at`).bind(t),
  ];
  for (let i=0; i<tracks.length; i++) statements.push(env.DB.prepare(`INSERT INTO queue_entries(queue_key,track_id,position,added_at,updated_at) VALUES('album-current',?,?,?,?)`).bind(Number(tracks[i].id),i,t,t));
  statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS album_play_history (id INTEGER PRIMARY KEY AUTOINCREMENT,album_id INTEGER NOT NULL,album_name TEXT,artist TEXT,artwork_url TEXT,played_at TEXT NOT NULL)`));
  statements.push(env.DB.prepare(`INSERT INTO album_play_history(album_id,album_name,artist,artwork_url,played_at) VALUES(?,?,?,?,?)`).bind(id,tracks[0].album_name,tracks[0].artist,tracks[0].artwork_url,t));
  await d1(() => env.DB.batch(statements));
  const acquisition = await enqueueAcquisition(env.DB, env, Number(tracks[0].id), "high", ctx);
  const queue = await d1(() => env.DB.prepare(`SELECT q.id AS queue_entry_id,q.position,t.* FROM queue_entries q JOIN tracks t ON t.id=q.track_id WHERE q.queue_key='album-current' ORDER BY q.position`).all());
  return json({ok:true,mode:"album",album_id:id,current_index:0,tracks:queue.results||[],acquisition},200,request);
}

export async function reconcileAcquisitions(db) {
  await ensureAcquisitionJobs(db);
  const active = await d1(() => db.prepare(`SELECT j.id,j.track_id,j.status,j.updated_at,t.storage_key,t.storage_status FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id WHERE j.status IN ('queued','running') ORDER BY j.created_at LIMIT 100`).all());
  for (const job of active.results || []) {
    if (job.storage_status === "available" && job.storage_key) {
      const t = now();
      await d1(() => db.prepare(`UPDATE acquisition_jobs SET status='completed',storage_key=?,completed_at=?,updated_at=?,error=NULL WHERE id=?`).bind(String(job.storage_key),t,t,job.id).run());
    }
  }
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const stale = await d1(() => db.prepare(`SELECT id,track_id FROM acquisition_jobs WHERE status='running' AND updated_at < ?`).bind(cutoff).all());
  for (const job of stale.results || []) {
    const t = now();
    await d1(() => db.prepare(`UPDATE acquisition_jobs SET status='failed',error='Acquisition timed out',updated_at=? WHERE id=? AND status='running'`).bind(t,job.id).run());
    await d1(() => db.prepare(`UPDATE tracks SET storage_status='failed',updated_at=? WHERE id=? AND COALESCE(storage_status,'missing')='queued'`).bind(t,job.track_id).run());
  }
}

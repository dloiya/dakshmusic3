const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });

async function columns(db, table) {
  const r = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((r.results || []).map(x => x.name));
}

async function track(db, id) {
  return (await db.prepare('SELECT * FROM tracks WHERE id = ?').bind(id).first()) || null;
}

function sourceParts(url) {
  try {
    const u = new URL(url); const h = u.hostname.replace(/^www\./, '').toLowerCase();
    const source = h.includes('deezer') ? 'deezer' : h.includes('spotify') ? 'spotify' : h.includes('youtube') || h === 'youtu.be' ? 'youtube' : h.includes('apple') ? 'apple-music' : h.includes('soundcloud') ? 'soundcloud' : h.includes('bandcamp') ? 'bandcamp' : h.includes('qobuz') ? 'qobuz' : h.includes('tidal') ? 'tidal' : 'unknown';
    const m = url.match(/(?:track|album|playlist|video)[/:]([A-Za-z0-9_-]+)/i);
    return { source, source_id: m?.[1] || null };
  } catch { return { source: 'unknown', source_id: null }; }
}

async function enqueue(env, body) {
  const url = String(body.url || '').trim(); if (!url) return json({ error: 'url required' }, 400);
  const c = await columns(env.DB, 'tracks'); const s = sourceParts(url);
  let t = c.has('source_url') ? await env.DB.prepare('SELECT * FROM tracks WHERE source_url = ? LIMIT 1').bind(url).first() : null;
  if (!t && c.has('source_id') && s.source_id) t = await env.DB.prepare('SELECT * FROM tracks WHERE source = ? AND source_id = ? LIMIT 1').bind(s.source, s.source_id).first();
  if (!t) {
    if (!c.has('title') || !c.has('artist')) return json({ error: 'existing tracks schema lacks title/artist' }, 500);
    const fields = ['title','artist']; const vals = [body.title || 'Pending acquisition', body.artist || 'Unknown'];
    for (const [k,v] of [['album_name',body.album],['source',s.source],['source_id',s.source_id],['source_url',url],['isrc',body.isrc]]) if (c.has(k) && v != null) { fields.push(k); vals.push(v); }
    const qs = fields.map(() => '?').join(',');
    await env.DB.prepare(`INSERT INTO tracks (${fields.join(',')}) VALUES (${qs})`).bind(...vals).run();
    t = c.has('source_url') ? await env.DB.prepare('SELECT * FROM tracks WHERE source_url = ? LIMIT 1').bind(url).first() : null;
    if (!t) return json({ error: 'track created but could not reload it' }, 500);
  }
  const existing = await env.DB.prepare("SELECT id,status FROM acquisition_jobs WHERE track_id = ? AND status IN ('queued','dispatched','running') LIMIT 1").bind(t.id).first();
  if (existing) return json({ job: existing, track: t, reused: true });
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO acquisition_jobs (id,track_id,status,worker,attempts) VALUES (?,?,'queued',NULL,0)").bind(id,t.id).run();
  return json({ job: { id, track_id: t.id, status: 'queued' }, track: t });
}

async function claim(env, body) {
  const worker = String(body.worker || 'oracle');
  const job = await env.DB.prepare("SELECT j.*, t.title, t.artist, t.album_name, t.source, t.source_id, t.source_url, t.isrc FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id WHERE j.status='queued' AND j.attempts < 3 ORDER BY j.created_at LIMIT 1").first();
  if (!job) return json({ job: null });
  const r = await env.DB.prepare("UPDATE acquisition_jobs SET status='running',worker=?,attempts=attempts+1,started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='queued'").bind(worker,job.id).run();
  if (!r.success) return json({ job: null });
  return json({ job: { ...job, status: 'running', worker, attempts: job.attempts + 1 } });
}

async function upload(env, request, id) {
  const job = await env.DB.prepare("SELECT * FROM acquisition_jobs WHERE id=? AND status='running'").bind(id).first();
  if (!job) return json({ error: 'job not running' }, 409);
  const bytes = await request.arrayBuffer(); if (!bytes.byteLength) return json({ error: 'empty upload' }, 400);
  const key = `audio/tracks/${job.track_id}.flac`;
  await env.AUDIO.put(key, bytes, { httpMetadata: { contentType: 'audio/flac' } });
  const c = await columns(env.DB, 'tracks');
  if (c.has('storage_key') && c.has('storage_status')) await env.DB.prepare("UPDATE tracks SET storage_key=?,storage_status='complete',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(key,job.track_id).run();
  else if (c.has('storage_key')) await env.DB.prepare("UPDATE tracks SET storage_key=? WHERE id=?").bind(key,job.track_id).run();
  await env.DB.prepare("UPDATE acquisition_jobs SET status='complete',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,error=NULL WHERE id=?").bind(id).run();
  return json({ ok: true, key });
}

async function fail(env, body, id) {
  const err = String(body.error || 'acquisition failed').slice(0, 4000);
  const j = await env.DB.prepare('SELECT attempts FROM acquisition_jobs WHERE id=?').bind(id).first(); if (!j) return json({ error: 'job not found' }, 404);
  const status = j.attempts < 3 ? 'queued' : 'failed';
  await env.DB.prepare('UPDATE acquisition_jobs SET status=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status,err,id).run();
  return json({ ok: true, status });
}

export default { async fetch(request, env) {
  const u = new URL(request.url);
  try {
    if (u.pathname === '/api/health') return json({ ok: true, service: 'dakshmusic3' });
    if (u.pathname === '/api/jobs' && request.method === 'POST') return enqueue(env, await request.json());
    if (u.pathname === '/api/jobs/claim' && request.method === 'POST') return claim(env, await request.json());
    const m = u.pathname.match(/^\/api\/jobs\/([^/]+)\/upload$/); if (m && request.method === 'PUT') return upload(env, request, m[1]);
    const f = u.pathname.match(/^\/api\/jobs\/([^/]+)\/fail$/); if (f && request.method === 'POST') return fail(env, await request.json(), f[1]);
    if (u.pathname === '/api/jobs' && request.method === 'GET') { const r = await env.DB.prepare("SELECT j.*,t.title,t.artist,t.source FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id ORDER BY j.created_at DESC LIMIT 100").all(); return json({ jobs: r.results || [] }); }
    return env.ASSETS.fetch(request);
  } catch (e) { console.error(e); return json({ error: String(e.message || e) }, 500); }
} };

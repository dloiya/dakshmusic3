import { getInstance, instanceAction } from "./oci.js";

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

function json(data, status = 200, request = null, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...(request ? corsHeaders(request) : {}), ...extra },
  });
}

function error(request, message, status = 400, extra = {}) {
  return json({ error: message }, status, request, extra);
}

function isTransientD1Error(err) {
  const msg = String(err?.message || err);
  return (
    msg.includes("Network connection lost") ||
    msg.includes("storage caused object to be reset") ||
    msg.includes("reset because its code was updated")
  );
}

function shouldRetry(err, attempt) {
  return attempt <= 9 && isTransientD1Error(err);
}

async function withD1Retry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!shouldRetry(err, attempt)) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function retryableD1(db) {
  const wrapStatement = (statement) => new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (["run", "first", "all", "raw"].includes(property)) {
        return (...args) => withD1Retry(() => value.apply(target, args));
      }
      if (property === "bind") {
        return (...args) => wrapStatement(value.apply(target, args));
      }
      return value.bind(target);
    },
  });

  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "prepare") return (...args) => wrapStatement(target.prepare(...args));
      if (property === "batch") return (...args) => withD1Retry(() => target.batch(...args));
      if (typeof value !== "function") return value;
      return value.bind(target);
    },
  });
}

function ociBase(env) {
  const value = env.OCI_API_URL?.trim();
  if (!value) throw new Error("OCI_API_URL is not configured");
  return value.replace(/\/$/, "");
}

async function ociRequest(request, env, path, init = {}) {
  if (!env.OCI_API_TOKEN) throw new Error("OCI_API_TOKEN is not configured");
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${env.OCI_API_TOKEN}`);
  headers.set("Accept", "application/json");
  const upstream = await fetch(`${ociBase(env)}${path}`, { ...init, headers });
  const text = await upstream.text();
  let data;
  try { data = JSON.parse(text); }
  catch { data = { detail: text || `OCI returned HTTP ${upstream.status}` }; }
  return json(data, upstream.status, request);
}

async function callRetriever(env, track, priority = "normal") {
  const url = track?.source_url;
  if (!url) throw new Error("Track has no source_url");
  if (!env.OCI_API_TOKEN) throw new Error("OCI_API_TOKEN is not configured");

  const encoded = encodeURIComponent(url);
  const headers = {
    Authorization: `Bearer ${env.OCI_API_TOKEN}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const upstream = await fetch(`${ociBase(env)}/acquire/${encoded}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      track_id: Number(track.id),
      source_url: url,
      title: track.title,
      artist: track.artist,
      album_name: track.album_name || null,
      priority,
    }),
  });

  const text = await upstream.text();
  let data = {};
  try { data = JSON.parse(text); }
  catch { data = { detail: text }; }
  return { ok: upstream.ok, status: upstream.status, data };
}

// Acquisition is fire-and-forget. The Worker does not create or poll
// acquisition_jobs; the retriever owns acquisition state.
async function dispatchAcquisition(db, env, trackId, priority = "normal", ctx = null) {
  const track = await db.prepare(`
    SELECT id,title,artist,album_name,source_url,storage_key,storage_status
    FROM tracks WHERE id=?
  `).bind(Number(trackId)).first();

  if (!track) return null;
  if (track.storage_status === "ready" && track.storage_key) {
    return { ready: true, track_id: Number(track.id) };
  }

  const run = async () => {
    try {
      const result = await callRetriever(env, track, priority);
      if (!result.ok) {
        throw new Error(result.data?.detail || result.data?.error || `OCI retriever returned HTTP ${result.status}`);
      }

      const d = result.data || {};
      const storageKey = d.storage_key || d.key || d.r2_key || null;
      if (storageKey) {
        await db.prepare(`
          UPDATE tracks
          SET storage_key=?,storage_status='ready',cache_requested=1,updated_at=?
          WHERE id=?
        `).bind(String(storageKey), now(), Number(track.id)).run();
      } else {
        await db.prepare(`
          UPDATE tracks
          SET storage_status='downloading',cache_requested=1,updated_at=?
          WHERE id=?
        `).bind(now(), Number(track.id)).run();
      }
    } catch (err) {
      console.error("OCI retriever acquisition failed", track.id, err);
      await db.prepare(`
        UPDATE tracks SET storage_status='failed',updated_at=? WHERE id=?
      `).bind(now(), Number(track.id)).run().catch((dbErr) => {
        console.error("Failed to persist acquisition error state", dbErr);
      });
    }
  };

  if (ctx) ctx.waitUntil(run());
  else await run();
  return { track_id: Number(track.id), status: "dispatched", priority };
}

async function deezerSearch(request) {
  const u = new URL(request.url);
  const q = u.searchParams.get("q")?.trim();
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") || 25), 1), 50);
  if (!q) return error(request, "Missing q");
  const d = new URL("https://api.deezer.com/search");
  d.searchParams.set("q", q);
  d.searchParams.set("limit", String(limit));
  const r = await fetch(d, { headers: { accept: "application/json" } });
  if (!r.ok) return error(request, `Deezer search failed: HTTP ${r.status}`, 502);
  const data = await r.json();
  if (data?.error) return error(request, data.error.message || "Deezer search failed", 502);
  return json(data, 200, request, { "cache-control": "public, max-age=60, s-maxage=300" });
}

async function ensureHistory(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS album_play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id INTEGER NOT NULL,
      album_name TEXT,
      artist TEXT,
      artwork_url TEXT,
      played_at TEXT NOT NULL
    )
  `).run();
}

async function upsertTrack(db, t) {
  if (!t?.title || !t?.artist || !t?.source || !t?.source_id || !t?.source_url) {
    throw new Error("title, artist, source, source_id and source_url are required");
  }

  const albumId = t.album_id == null ? null : Number(t.album_id);
  const albumName = t.album_name || null;
  const source = String(t.source);
  const sourceId = String(t.source_id);
  const sourceUrl = String(t.source_url);
  const artwork = t.artwork_url || null;
  const metadata = t.metadata_json ? JSON.stringify(t.metadata_json) : null;
  const duration = t.duration_ms == null ? null : Number(t.duration_ms);
  const title = String(t.title);
  const artist = String(t.artist);
  const ts = now();

  if (albumId != null) {
    await db.prepare(`
      INSERT INTO albums(id,title,artist,source,source_id,artwork_url,year,created_at,updated_at)
      VALUES(?,?,?,?,?,?,NULL,?,?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        artist=excluded.artist,
        source=excluded.source,
        source_id=excluded.source_id,
        artwork_url=excluded.artwork_url,
        updated_at=excluded.updated_at
    `).bind(albumId, albumName || "Unknown Album", artist, source, String(albumId), artwork, ts, ts).run();
  }

  const existing = await db.prepare(`SELECT id FROM tracks WHERE source=? AND source_id=? LIMIT 1`).bind(source, sourceId).first();
  if (existing) {
    await db.prepare(`
      UPDATE tracks SET title=?,artist=?,album_id=?,album_name=?,source_url=?,isrc=?,
      duration_ms=?,artwork_url=?,metadata_json=?,updated_at=? WHERE id=?
    `).bind(title, artist, albumId, albumName, sourceUrl, t.isrc || null, duration, artwork, metadata, ts, existing.id).run();
    return Number(existing.id);
  }

  const r = await db.prepare(`
    INSERT INTO tracks(
      title,artist,album_id,album_name,source,source_id,source_url,isrc,duration_ms,
      artwork_url,storage_status,play_count,cache_requested,created_at,updated_at,metadata_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?, 'missing',0,0,?,?,?)
  `).bind(title, artist, albumId, albumName, source, sourceId, sourceUrl, t.isrc || null, duration, artwork, ts, ts, metadata).run();
  return Number(r.meta.last_row_id);
}

async function trackRows(db, limit = 2000) {
  const r = await db.prepare(`
    SELECT id,title,artist,album_id,album_name,source,source_id,source_url,isrc,
    duration_ms,artwork_url,storage_key,storage_status,play_count,cache_requested,
    created_at,updated_at,metadata_json FROM tracks ORDER BY artist,title LIMIT ?
  `).bind(limit).all();
  return r.results || [];
}

async function albumRows(db, id) {
  const r = await db.prepare(`
    SELECT id,title,artist,album_id,album_name,source,source_id,source_url,isrc,
    duration_ms,artwork_url,storage_key,storage_status,play_count,cache_requested,
    created_at,updated_at,metadata_json FROM tracks WHERE album_id=? ORDER BY id
  `).bind(Number(id)).all();
  return r.results || [];
}

async function albumList(db, limit = 1000) {
  const r = await db.prepare(`
    SELECT album_id AS id,album_name AS title,MAX(artist) AS artist,
    MAX(artwork_url) AS artwork_url,COUNT(*) AS track_count,MAX(updated_at) AS updated_at
    FROM tracks WHERE album_id IS NOT NULL
    GROUP BY album_id,album_name ORDER BY artist,album_name LIMIT ?
  `).bind(limit).all();
  return r.results || [];
}

async function playlistRows(db) {
  const r = await db.prepare(`
    SELECT p.id AS playlist_entry_id,p.position,t.id,t.title,t.artist,t.album_id,t.album_name,
    t.source,t.source_id,t.source_url,t.isrc,t.duration_ms,t.artwork_url,t.storage_key,
    t.storage_status,t.play_count,t.metadata_json
    FROM playlist_entries p JOIN tracks t ON t.id=p.track_id
    ORDER BY p.position,p.id
  `).all();
  return r.results || [];
}

async function queueRows(db, key) {
  const r = await db.prepare(`
    SELECT q.id AS queue_entry_id,q.position,t.id,t.title,t.artist,t.album_id,t.album_name,
    t.source,t.source_id,t.source_url,t.artwork_url,t.duration_ms,t.storage_key,
    t.storage_status,t.play_count,t.metadata_json
    FROM queue_entries q JOIN tracks t ON t.id=q.track_id
    WHERE q.queue_key=? ORDER BY q.position
  `).bind(key).all();
  return r.results || [];
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const columns = ["id","title","artist","album_id","album_name","source","source_id","source_url","isrc","duration_ms","artwork_url","storage_key","storage_status","play_count","cache_requested","created_at","updated_at"];
  return [columns.join(","), ...rows.map((r) => columns.map((k) => csvEscape(r[k])).join(","))].join("\n");
}

function parseCsv(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const parse = (s) => {
    const a = []; let x = ""; let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') {
        if (quoted && s[i + 1] === '"') { x += '"'; i++; }
        else quoted = !quoted;
      } else if (c === "," && !quoted) { a.push(x); x = ""; }
      else x += c;
    }
    a.push(x);
    return a;
  };
  const h = parse(lines[0]);
  return lines.slice(1).map((line) => {
    const v = parse(line), o = {};
    h.forEach((k, i) => { o[k] = v[i] ?? ""; });
    return o;
  });
}

export async function watchdog(env, reason = "scheduled") {
  if (env.OCI_API_URL && env.OCI_API_TOKEN) {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 5000);
    try {
      const r = await fetch(`${ociBase(env)}/health`, {
        headers: { Authorization: `Bearer ${env.OCI_API_TOKEN}`, Accept: "application/json" },
        signal: c.signal,
        cache: "no-store",
      });
      if (r.ok) return { status: "healthy", action: "none", reason };
    } catch {}
    finally { clearTimeout(timer); }
  }

  const instance = await getInstance(env);
  const state = instance?.lifecycleState;
  if (state === "STOPPED") {
    await instanceAction(env, "START");
    return { status: "recovering", action: "START", lifecycleState: state, reason };
  }
  if (state === "STARTING" || state === "STOPPING") return { status: "waiting", action: "none", lifecycleState: state, reason };
  if (state === "RUNNING") {
    await instanceAction(env, "RESET");
    return { status: "recovering", action: "RESET", lifecycleState: state, reason };
  }
  return { status: "waiting", action: "none", lifecycleState: state, reason };
}

async function handle(request, env, ctx) {
  const db = retryableD1(env.DB);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/g, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

  try {
    if (path === "/api/health" && method === "GET") {
      await db.prepare("SELECT 1 AS ok").first();
      return json({ ok:true, service:"dakshmusic3" }, 200, request);
    }
    if (path === "/api/search" && method === "GET") return deezerSearch(request);
    if (path === "/api/watchdog" && method === "POST") return json(await watchdog(env,"manual"),200,request);
    if (path === "/api/start" && method === "POST") return ociRequest(request,env,"/start",{method:"POST"});

    if (path === "/api/library/tracks" && method === "GET") {
      const n = Math.min(Math.max(Number(url.searchParams.get("limit") || 500),1),2000);
      return json({tracks:await trackRows(db,n)},200,request);
    }
    if (path === "/api/library/albums" && method === "GET") {
      const n = Math.min(Math.max(Number(url.searchParams.get("limit") || 500),1),1000);
      return json({albums:await albumList(db,n)},200,request);
    }

    const am = path.match(/^\/api\/library\/albums\/(\d+)$/);
    if (am && method === "GET") {
      const rows = await albumRows(db,am[1]);
      if (!rows.length) return error(request,"Album not found",404);
      return json({album:{id:Number(am[1]),title:rows[0].album_name,artist:rows[0].artist,artwork_url:rows[0].artwork_url,track_count:rows.length},tracks:rows},200,request);
    }

    if (path === "/api/tracks/resolve" && method === "POST") {
      const id = await upsertTrack(db,await request.json());
      return json({ok:true,track_id:id},200,request);
    }

    if (path === "/api/playlist" && method === "GET") return json({name:"default",tracks:await playlistRows(db)},200,request);
    if (path === "/api/playlist" && method === "POST") {
      const b = await request.json(), id = Number(b.track_id);
      if (!id) return error(request,"track_id is required");
      const d = await db.prepare(`SELECT id,position FROM playlist_entries WHERE track_id=? LIMIT 1`).bind(id).first();
      if (d) return json({ok:true,duplicate:true,id:Number(d.id),position:Number(d.position)},200,request);
      const m = await db.prepare(`SELECT COALESCE(MAX(position),-1) p FROM playlist_entries`).first();
      const p = Number(m?.p ?? -1)+1, t = now();
      const r = await db.prepare(`INSERT INTO playlist_entries(track_id,position,added_at,updated_at) VALUES(?,?,?,?)`).bind(id,p,t,t).run();
      return json({ok:true,id:Number(r.meta.last_row_id),track_id:id,position:p},200,request);
    }
    const pm = path.match(/^\/api\/playlist\/(\d+)$/);
    if (pm && method === "DELETE") {
      await db.prepare(`DELETE FROM playlist_entries WHERE id=?`).bind(Number(pm[1])).run();
      return json({ok:true},200,request);
    }

    if (path === "/api/queue" && method === "GET") {
      const key = url.searchParams.get("queue_key") || env.DEFAULT_QUEUE_KEY || "default";
      const state = await db.prepare(`SELECT queue_key,current_index,mode,shuffle_enabled,updated_at FROM queue_state WHERE queue_key=?`).bind(key).first() || {queue_key:key,current_index:0,mode:"track",shuffle_enabled:1,updated_at:null};
      return json({queue_key:key,state,tracks:await queueRows(db,key)},200,request);
    }
    if (path === "/api/queue/add" && method === "POST") {
      const b = await request.json(), key = b.queue_key || env.DEFAULT_QUEUE_KEY || "default", id = await upsertTrack(db,b.track);
      await db.prepare(`INSERT INTO queue_state(queue_key,current_index,mode,shuffle_enabled,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(queue_key) DO NOTHING`).bind(key,0,"track",now()).run();
      const d = await db.prepare(`SELECT id,position FROM queue_entries WHERE queue_key=? AND track_id=? LIMIT 1`).bind(key,id).first();
      if (d) return json({ok:true,track_id:id,queue_entry_id:Number(d.id),position:Number(d.position),duplicate:true},200,request);
      const m = await db.prepare(`SELECT COALESCE(MAX(position),-1) p FROM queue_entries WHERE queue_key=?`).bind(key).first();
      const p = Number(m?.p ?? -1)+1, timestamp = now();
      const r = await db.prepare(`INSERT INTO queue_entries(queue_key,track_id,position,added_at,updated_at) VALUES(?,?,?,?,?)`).bind(key,id,p,timestamp,timestamp).run();
      return json({ok:true,track_id:id,queue_entry_id:Number(r.meta.last_row_id),position:p},200,request);
    }
    const qm = path.match(/^\/api\/queue\/(\d+)$/);
    if (qm && method === "DELETE") {
      await db.prepare(`DELETE FROM queue_entries WHERE id=?`).bind(Number(qm[1])).run();
      return json({ok:true},200,request);
    }
    if (path === "/api/queue/next" && method === "POST") {
      const key = url.searchParams.get("queue_key") || env.DEFAULT_QUEUE_KEY || "default";
      const state = await db.prepare(`SELECT queue_key,current_index,mode,shuffle_enabled FROM queue_state WHERE queue_key=?`).bind(key).first() || {current_index:0,mode:"track",shuffle_enabled:1};
      const rows = await queueRows(db,key), next = rows.length ? (Number(state.current_index)+1)%rows.length : 0;
      await db.prepare(`INSERT INTO queue_state(queue_key,current_index,mode,shuffle_enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(queue_key) DO UPDATE SET current_index=excluded.current_index,mode=excluded.mode,shuffle_enabled=excluded.shuffle_enabled,updated_at=excluded.updated_at`).bind(key,next,state.mode||"track",Number(state.shuffle_enabled??1),now()).run();
      return json({ok:true,current_index:next},200,request);
    }
    if (path === "/api/queue/shuffle" && method === "POST") {
      const b = await request.json(), key = b.queue_key || env.DEFAULT_QUEUE_KEY || "default", enabled = b.enabled ? 1 : 0;
      const state = await db.prepare(`SELECT current_index,mode FROM queue_state WHERE queue_key=?`).bind(key).first() || {current_index:0,mode:"track"};
      await db.prepare(`INSERT INTO queue_state(queue_key,current_index,mode,shuffle_enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(queue_key) DO UPDATE SET shuffle_enabled=excluded.shuffle_enabled,updated_at=excluded.updated_at`).bind(key,Number(state.current_index||0),state.mode||"track",enabled,now()).run();
      return json({ok:true,shuffle_enabled:enabled},200,request);
    }

    // Acquisition status polling/tracking is intentionally disabled.
    if (path === "/api/acquisition" && method === "GET") return error(request,"Acquisition status tracking is disabled",410);
    if (path === "/api/acquisition" && method === "POST") {
      const b = await request.json(), id = Number(b.track_id);
      if (!id) return error(request,"track_id is required");
      const result = await dispatchAcquisition(db,env,id,b.priority||"normal",ctx);
      if (!result) return error(request,"Track not found",404);
      return json({ok:true,...result},202,request);
    }

    if (path === "/api/playback/mode" && method === "POST") {
      const b = await request.json(), mode = String(b.mode||"").toLowerCase();
      if (!["track","album"].includes(mode)) return error(request,"mode must be track or album");
      await db.prepare(`INSERT INTO queue_state(queue_key,current_index,mode,shuffle_enabled,updated_at) VALUES('default',0,?,1,?) ON CONFLICT(queue_key) DO UPDATE SET current_index=0,mode=excluded.mode,updated_at=excluded.updated_at`).bind(mode,now()).run();
      return json({ok:true,mode},200,request);
    }
    if (path === "/api/play/track" && method === "POST") {
      const b = await request.json(), id = Number(b.track_id);
      if (!id) return error(request,"track_id is required");
      const track = await db.prepare(`SELECT * FROM tracks WHERE id=?`).bind(id).first();
      if (!track) return error(request,"Track not found",404);
      await db.prepare(`UPDATE tracks SET play_count=COALESCE(play_count,0)+1,updated_at=? WHERE id=?`).bind(now(),id).run();
      const acquisition = await dispatchAcquisition(db,env,id,"high",ctx);
      return json({ok:true,track,acquisition},200,request);
    }
    if (path.startsWith("/api/play/album/") && method === "POST") {
      const id = Number(path.split("/").pop());
      if (!id) return error(request,"album id is required");
      const tracks = await albumRows(db,id);
      if (!tracks.length) return error(request,"Album not found",404);
      const statements = [
        db.prepare(`DELETE FROM queue_entries WHERE queue_key='album-current'`),
        db.prepare(`INSERT INTO queue_state(queue_key,current_index,mode,shuffle_enabled,updated_at) VALUES('album-current',0,'album',1,?) ON CONFLICT(queue_key) DO UPDATE SET current_index=0,mode='album',updated_at=excluded.updated_at`).bind(now()),
      ];
      for (let i=0;i<tracks.length;i++) {
        const t=now();
        statements.push(db.prepare(`INSERT INTO queue_entries(queue_key,track_id,position,added_at,updated_at) VALUES('album-current',?,?,?,?,?)`).bind(tracks[i].id,i,t,t));
      }
      statements.push(db.prepare(`UPDATE albums SET updated_at=? WHERE id=?`).bind(now(),id));
      await db.batch(statements);
      for (let i=0;i<tracks.length;i++) await dispatchAcquisition(db,env,Number(tracks[i].id),i===0?"high":"normal",ctx);
      await ensureHistory(db);
      await db.prepare(`INSERT INTO album_play_history(album_id,album_name,artist,artwork_url,played_at) VALUES(?,?,?,?,?)`).bind(id,tracks[0].album_name,tracks[0].artist,tracks[0].artwork_url,now()).run();
      return json({ok:true,album_id:id,tracks},200,request);
    }
    if (path === "/api/albums/history" && method === "GET") {
      await ensureHistory(db);
      const r = await db.prepare(`SELECT album_id AS id,album_name AS title,MAX(artist) AS artist,MAX(artwork_url) AS artwork_url,COUNT(*) AS plays,MAX(played_at) AS played_at FROM album_play_history GROUP BY album_id,album_name ORDER BY played_at DESC LIMIT 50`).all();
      return json({albums:r.results||[]},200,request);
    }

    if (path === "/api/export/tracks.csv" && method === "GET") {
      const rows = await trackRows(db,200000);
      return new Response(toCsv(rows),{status:200,headers:{"content-type":"text/csv; charset=utf-8","content-disposition":"attachment; filename=tracks.csv",...corsHeaders(request)}});
    }
    if (path === "/api/import/tracks.csv" && method === "POST") {
      const rows = parseCsv(await request.text()); let imported=0;
      for (const row of rows) {
        try {
          await upsertTrack(db,{...row,album_id:row.album_id?Number(row.album_id):null,duration_ms:row.duration_ms?Number(row.duration_ms):null,metadata_json:row.metadata_json||null});
          imported++;
        } catch (e) { console.error("CSV row import failed",e); }
      }
      return json({ok:true,imported,total:rows.length},200,request);
    }
    if (path === "/api/data/delete" && method === "POST") {
      const b = await request.json();
      if (b.confirm !== "DELETE") return error(request,"Confirmation required");
      await db.batch([
        db.prepare(`DELETE FROM queue_entries`),
        db.prepare(`DELETE FROM playlist_entries`),
        db.prepare(`DELETE FROM acquisition_jobs`),
        db.prepare(`DELETE FROM album_play_history`),
        db.prepare(`DELETE FROM tracks`),
        db.prepare(`DELETE FROM albums`),
        db.prepare(`DELETE FROM queue_state`),
      ]);
      return json({ok:true},200,request);
    }
    return error(request,"Not found",404);
  } catch (err) {
    console.error("API error",err);
    if (isTransientD1Error(err)) {
      return error(
        request,
        "Temporary database outage. Please retry.",
        503,
        { "retry-after": "60" }
      );
    }
    return error(request,err?.message||"Internal error",500);
  }
}

export default { fetch:handle, scheduled:async(controller,env)=>watchdog(env,"scheduled") };

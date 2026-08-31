import legacy from "./index.js";
import { getInstance, instanceAction } from "./oci.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return { "access-control-allow-origin": origin || "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "Content-Type, Authorization", "access-control-max-age": "86400", vary: "Origin" };
}
function json(data, status = 200, request = null, extra = {}) { return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...(request ? corsHeaders(request) : {}), ...extra } }); }
function error(request, message, status = 400) { return json({ error: message }, status, request); }
function ociBase(env) { const value = env.OCI_API_URL?.trim(); if (!value) throw new Error("OCI_API_URL is not configured"); return value.replace(/\/$/, ""); }
async function ociRequest(request, env, path, init = {}) { const token = env.OCI_API_TOKEN; if (!token) throw new Error("OCI_API_TOKEN is not configured"); const headers = new Headers(init.headers || {}); headers.set("Authorization", `Bearer ${token}`); headers.set("Accept", "application/json"); const upstream = await fetch(`${ociBase(env)}${path}`, { ...init, headers }); const text = await upstream.text(); let data; try { data = JSON.parse(text); } catch { data = { detail: text || `OCI returned HTTP ${upstream.status}` }; } return json(data, upstream.status, request); }
async function deezerSearch(request) { const url = new URL(request.url); const query = url.searchParams.get("q")?.trim(); const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 25), 1), 50); if (!query) return error(request, "Missing q"); const deezerUrl = new URL("https://api.deezer.com/search"); deezerUrl.searchParams.set("q", query); deezerUrl.searchParams.set("limit", String(limit)); const upstream = await fetch(deezerUrl.toString(), { headers: { accept: "application/json" } }); if (!upstream.ok) return error(request, `Deezer search failed: HTTP ${upstream.status}`, 502); const data = await upstream.json(); if (data?.error) return error(request, data.error.message || "Deezer search failed", 502); return json(data, 200, request, { "cache-control": "public, max-age=60, s-maxage=300" }); }
async function apiHealthy(env) { if (!env.OCI_API_URL || !env.OCI_API_TOKEN) return false; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000); try { const response = await fetch(`${ociBase(env)}/health`, { headers: { Authorization: `Bearer ${env.OCI_API_TOKEN}`, Accept: "application/json" }, signal: controller.signal, cache: "no-store" }); return response.ok; } catch { return false; } finally { clearTimeout(timer); } }
export async function watchdog(env, reason = "scheduled") { const healthy = await apiHealthy(env); if (healthy) return { status: "healthy", action: "none", reason }; const instance = await getInstance(env); const state = instance?.lifecycleState; if (state === "STOPPED" || state === "STOPPING") { if (state === "STOPPED") await instanceAction(env, "START"); return { status: "recovering", action: "START", lifecycleState: state, reason }; } if (state === "RUNNING") { await instanceAction(env, "RESET"); return { status: "recovering", action: "RESET", lifecycleState: state, reason }; } return { status: "waiting", action: "none", lifecycleState: state, reason }; }

async function ensurePlaybackTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS album_play_history (id INTEGER PRIMARY KEY AUTOINCREMENT, album_id INTEGER NOT NULL, album_name TEXT, artist TEXT, artwork_url TEXT, played_at TEXT NOT NULL)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_album_play_history_played ON album_play_history(played_at DESC)`).run();
}
async function libraryTracks(env, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 500), 1), 2000);
  const result = await env.DB.prepare(`SELECT id,title,artist,album_id,album_name,source,source_id,source_url,isrc,duration_ms,artwork_url,storage_key,storage_status,play_count,cache_requested,created_at,updated_at,metadata_json FROM tracks ORDER BY artist,title LIMIT ?`).bind(limit).all();
  return result.results || [];
}
async function libraryAlbums(env, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 500), 1), 1000);
  const result = await env.DB.prepare(`SELECT album_id AS id, album_name AS title, MAX(artist) AS artist, MAX(artwork_url) AS artwork_url, COUNT(*) AS track_count, MAX(updated_at) AS updated_at FROM tracks WHERE album_id IS NOT NULL GROUP BY album_id, album_name ORDER BY artist,title LIMIT ?`).bind(limit).all();
  return result.results || [];
}
async function albumTracks(env, albumId) {
  const tracks = await env.DB.prepare(`SELECT id,title,artist,album_id,album_name,source,source_id,source_url,isrc,duration_ms,artwork_url,storage_key,storage_status,play_count,cache_requested,metadata_json FROM tracks WHERE album_id = ? ORDER BY id`).bind(albumId).all();
  return tracks.results || [];
}
async function playlistRows(env) {
  const result = await env.DB.prepare(`SELECT p.id AS playlist_entry_id,p.position,t.* FROM playlist_entries p JOIN tracks t ON t.id=p.track_id ORDER BY p.position,p.id`).all();
  return result.results || [];
}
function csvEscape(value) { const s = value == null ? "" : String(value); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function tracksCsv(rows) { const cols = ["id","title","artist","album_id","album_name","source","source_id","source_url","isrc","duration_ms","artwork_url","storage_key","storage_status","play_count","cache_requested","created_at","updated_at"]; return [cols.join(","), ...rows.map(r => cols.map(c => csvEscape(r[c])).join(","))].join("\n"); }
function parseCsv(text) { const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean); if (!lines.length) return []; const parse = line => { const out=[]; let cur="", quoted=false; for(let i=0;i<line.length;i++){const ch=line[i]; if(ch==='"'){if(quoted&&line[i+1]==='"'){cur+='"';i++;}else quoted=!quoted;}else if(ch===','&&!quoted){out.push(cur);cur="";}else cur+=ch;}out.push(cur);return out;}; const headers=parse(lines[0]); return lines.slice(1).map(line=>{const vals=parse(line), row={}; headers.forEach((h,i)=>row[h]=vals[i]??""); return row;}); }
async function clearPlaybackSession(env) { try { await env.DB.prepare(`DELETE FROM cache_objects WHERE scope = 'album_session'`).run(); } catch {} }

async function handle(request, env, ctx) {
  const url = new URL(request.url); const path = url.pathname.replace(/\/+$/, "") || "/"; const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

  try {
    if (path === "/api/health" && method === "GET") { await env.DB.prepare("SELECT 1 AS ok").first(); return json({ ok:true, service:"dakshmusic3" },200,request); }
    if (path === "/api/search" && method === "GET") return await deezerSearch(request);
    if (path === "/api/start" && method === "POST") return await ociRequest(request, env, "/start", { method:"POST" });
    if (path === "/api/watchdog" && method === "POST") return json(await watchdog(env,"manual"),200,request);

    if (path === "/api/library/tracks" && method === "GET") return json({ tracks: await libraryTracks(env,url) },200,request);
    if (path === "/api/library/albums" && method === "GET") return json({ albums: await libraryAlbums(env,url) },200,request);
    const albumMatch = path.match(/^\/api\/library\/albums\/(\d+)$/);
    if (albumMatch && method === "GET") { const id=Number(albumMatch[1]); const tracks=await albumTracks(env,id); if(!tracks.length) return error(request,"Album not found",404); return json({ album:{id,title:tracks[0].album_name,artist:tracks[0].artist,artwork_url:tracks[0].artwork_url,track_count:tracks.length},tracks },200,request); }

    if (path === "/api/playlist" && method === "GET") return json({ name:"default", tracks:await playlistRows(env) },200,request);
    if (path === "/api/playlist" && method === "POST") { const body=await request.json(); const trackId=Number(body.track_id); if(!trackId)return error(request,"track_id is required"); const duplicate=await env.DB.prepare(`SELECT id FROM playlist_entries WHERE track_id=?`).bind(trackId).first(); if(duplicate)return json({ok:true,duplicate:true,id:Number(duplicate.id)},200,request); const max=await env.DB.prepare(`SELECT COALESCE(MAX(position),-1) AS p FROM playlist_entries`).first(); const pos=Number(max?.p??-1)+1; const r=await env.DB.prepare(`INSERT INTO playlist_entries(track_id,position,added_at,updated_at) VALUES(?,?,?,?,?)`).bind(trackId,pos,new Date().toISOString(),new Date().toISOString()).run(); return json({ok:true,id:Number(r.meta.last_row_id),position:pos},201,request); }
    const playlistMatch=path.match(/^\/api\/playlist\/(\d+)$/);
    if(playlistMatch&&method==="DELETE"){await env.DB.prepare(`DELETE FROM playlist_entries WHERE id=?`).bind(Number(playlistMatch[1])).run();return json({ok:true},200,request);}
    if(path==="/api/playlist"&&method==="DELETE"){await env.DB.prepare(`DELETE FROM playlist_entries`).run();return json({ok:true},200,request);}

    if(path==="/api/play/track"&&method==="POST"){const body=await request.json();const id=Number(body.track_id);if(!id)return error(request,"track_id is required");await clearPlaybackSession(env);await env.DB.prepare(`UPDATE tracks SET play_count=COALESCE(play_count,0)+1,updated_at=? WHERE id=?`).bind(new Date().toISOString(),id).run();return json({ok:true,mode:"track",track_id:id},200,request);}
    if(path==="/api/play/album"&&method==="POST"){const body=await request.json();const id=Number(body.album_id);if(!id)return error(request,"album_id is required");const tracks=await albumTracks(env,id);if(!tracks.length)return error(request,"Album not found",404);await ensurePlaybackTable(env.DB);await clearPlaybackSession(env);const t=new Date().toISOString();const a=tracks[0];await env.DB.prepare(`INSERT INTO album_play_history(album_id,album_name,artist,artwork_url,played_at) VALUES(?,?,?,?,?)`).bind(id,a.album_name,a.artist,a.artwork_url,t).run();await env.DB.prepare(`DELETE FROM album_play_history WHERE id NOT IN (SELECT id FROM album_play_history ORDER BY played_at DESC LIMIT 5)`).run();return json({ok:true,mode:"album",album_id:id,tracks},200,request);}
    if(path==="/api/albums/history"&&method==="GET"){await ensurePlaybackTable(env.DB);const r=await env.DB.prepare(`SELECT album_id,title,artist,artwork_url,played_at FROM album_play_history ORDER BY played_at DESC LIMIT 5`).all();return json({albums:r.results||[]},200,request);}
    if(path==="/api/playback/mode"&&method==="POST"){const body=await request.json();const mode=body.mode;if(!["track","album"].includes(mode))return error(request,"mode must be track or album");if(mode==="track")await clearPlaybackSession(env);return json({ok:true,mode},200,request);}

    if(path==="/api/export/tracks.csv"&&method==="GET"){const rows=await libraryTracks(env,new URL(request.url));return new Response(tracksCsv(rows),{status:200,headers:{"content-type":"text/csv; charset=utf-8","content-disposition":"attachment; filename=tracks.csv",...corsHeaders(request)}});}
    if(path==="/api/import/tracks.csv"&&method==="POST"){const rows=parseCsv(await request.text());let imported=0;for(const r of rows){if(!r.title||!r.artist||!r.source||!r.source_id||!r.source_url)continue;const existing=await env.DB.prepare(`SELECT id FROM tracks WHERE source=? AND source_id=?`).bind(r.source,r.source_id).first();if(existing){await env.DB.prepare(`UPDATE tracks SET title=?,artist=?,album_id=?,album_name=?,source_url=?,isrc=?,duration_ms=?,artwork_url=?,storage_key=?,storage_status=?,updated_at=? WHERE id=?`).bind(r.title,r.artist,r.album_id?Number(r.album_id):null,r.album_name||null,r.source_url,r.isrc||null,r.duration_ms?Number(r.duration_ms):null,r.artwork_url||null,r.storage_key||null,r.storage_status||"missing",new Date().toISOString(),existing.id).run();}else{await env.DB.prepare(`INSERT INTO tracks(title,artist,album_id,album_name,source,source_id,source_url,isrc,duration_ms,artwork_url,storage_key,storage_status,play_count,cache_requested,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?)`).bind(r.title,r.artist,r.album_id?Number(r.album_id):null,r.album_name||null,r.source,r.source_id,r.source_url,r.isrc||null,r.duration_ms?Number(r.duration_ms):null,r.artwork_url||null,r.storage_key||null,r.storage_status||"missing",new Date().toISOString(),new Date().toISOString()).run();}imported++;}return json({ok:true,imported},200,request);}
    if(path==="/api/data/delete"&&method==="POST"){const body=await request.json();if(body.confirm!=="DELETE")return error(request,"Confirmation required: DELETE");await env.DB.batch([env.DB.prepare(`DELETE FROM playlist_entries`),env.DB.prepare(`DELETE FROM queue_entries`),env.DB.prepare(`DELETE FROM queue_state`),env.DB.prepare(`DELETE FROM acquisition_jobs`),env.DB.prepare(`DELETE FROM cache_objects`),env.DB.prepare(`DELETE FROM tracks`)]);return json({ok:true},200,request);}

    const prefix="/api/acquire/";if(path.startsWith(prefix)&&method==="POST"){const encoded=path.slice(prefix.length);if(!encoded)return error(request,"Missing source URL");decodeURIComponent(encoded);return await ociRequest(request,env,`/acquire/${encoded}`,{method:"POST"});}
    if(path==="/api/acquisition"&&method==="GET"){const limit=Math.min(Math.max(Number(url.searchParams.get("limit")||20),1),100);const r=await env.DB.prepare(`SELECT a.id,a.track_id,a.status,a.worker,a.attempts,a.error,a.created_at,a.updated_at,a.started_at,a.completed_at,t.title,t.artist,t.source_url FROM acquisition_jobs a JOIN tracks t ON t.id=a.track_id ORDER BY a.created_at DESC LIMIT ?`).bind(limit).all();return json({jobs:r.results||[]},200,request);}
    if(path==="/api/acquisition"&&method==="POST"){const body=await request.json();const trackId=Number(body.track_id);if(!trackId)return error(request,"track_id is required");const track=await env.DB.prepare(`SELECT id,source_url FROM tracks WHERE id=?`).bind(trackId).first();if(!track)return error(request,"Track not found",404);const active=await env.DB.prepare(`SELECT id,status FROM acquisition_jobs WHERE track_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).bind(trackId).first();if(active)return json({ok:true,job_id:active.id,status:active.status,duplicate:true},200,request);const id=crypto.randomUUID();await env.DB.prepare(`INSERT INTO acquisition_jobs(id,track_id,status,worker,attempts,error,created_at,updated_at) VALUES(?,?, 'queued',NULL,0,NULL,?,?)`).bind(id,trackId,new Date().toISOString(),new Date().toISOString()).run();return json({ok:true,job_id:id,status:"queued",source_url:track.source_url},202,request);}

    return legacy.fetch(request,env,ctx);
  } catch(error) { console.error(error); return json({error:error?.message||"Internal error"},500,request); }
}

export default {
  async fetch(request, env, ctx) { return handle(request, env, ctx); },
  async queue(batch, env, ctx) { for(const message of batch.messages){console.log("Processing metadata message:",message.body);message.ack();} },
  async scheduled(controller, env, ctx) { ctx.waitUntil(watchdog(env,`cron:${controller.cron}`).catch(error=>console.error("Scheduled OCI watchdog failed",error))); },
};

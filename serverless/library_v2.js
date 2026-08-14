// Playlist search queue + acquisition source URL fix deployed from main.
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8"}});
function cookie(req){return(req.headers.get("Cookie")||"").match(/(?:^|;\s*)music_session=([^;]+)/)?.[1]||null;}
async function sha256(text){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));return[...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("");}
async function auth(env,req){const token=cookie(req);if(!token)return false;const row=await env.DB.prepare(`SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?`).bind(await sha256(token),Math.floor(Date.now()/1000)).first();return!!row;}
const slug=s=>String(s||"unknown").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-zA-Z0-9]+/g,"-").replace(/^-+|-+$/g,"").toLowerCase()||"unknown";
const naturalKey=(x,i)=>x.source_id?`apple-${slug(x.source_id)}`:`apple-${slug(x.title)}-${slug(x.artist)}-${slug(x.album)}-${Number(x.duration_ms)||0}-${i}`;
async function dispatchWarm(env,trackId){const existing=await env.DB.prepare(`SELECT id FROM download_jobs WHERE track_id=? AND status IN ('queued','dispatched','running') ORDER BY created_at DESC LIMIT 1`).bind(trackId).first();if(existing)return existing.id;const track=await env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(trackId).first();if(!track?.source_url||!track.duration_ms||!env.GITHUB_TOKEN||!env.GITHUB_OWNER||!env.GITHUB_REPO)return null;const id=crypto.randomUUID();await env.DB.prepare(`INSERT INTO download_jobs(id,track_id,kind,status) VALUES(?,?,?,'queued')`).bind(id,trackId,"general").run();const r=await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/acquire-audio.yml/dispatches`,{method:"POST",headers:{Accept:"application/vnd.github+json",Authorization:`Bearer ${env.GITHUB_TOKEN}`,"X-GitHub-Api-Version":"2026-03-10","User-Agent":"dakshmusic3","Content-Type":"application/json"},body:JSON.stringify({ref:"main",inputs:{job_id:id,source_url:track.source_url,title:track.title,artist:track.artist||"",album:track.album||"",duration_ms:String(track.duration_ms)}})});if(!r.ok){const text=await r.text();await env.DB.prepare(`UPDATE download_jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(`GitHub dispatch ${r.status}: ${text}`,id).run();return null;}await env.DB.prepare(`UPDATE download_jobs SET status='dispatched',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();return id;}
function norm(s){return String(s||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/gi," ").trim().toLowerCase();}
function sameText(a,b){return norm(a)===norm(b);}
function artistMatches(candidate,wanted){const w=norm(wanted);if(!w)return false;const names=[candidate?.artist?.name,...(candidate?.contributors||[]).map(x=>x?.name)].filter(Boolean).map(norm);if(names.some(n=>n===w))return true;const wantedParts=w.split(" ").filter(Boolean);return names.some(n=>wantedParts.length>0&&wantedParts.every(p=>n.includes(p)));}
function deezerMeta(d,method){return d?.id&&!d?.error?{id:d.id,duration_ms:Number(d.duration)>0?Number(d.duration)*1000:null,artwork_url:d.album?.cover_xl||d.album?.cover_big||d.album?.cover_medium||d.album?.cover||null,method}:null;}
async function musicbrainzMetadataByIsrc(isrc){const value=String(isrc||"").replace(/[^A-Za-z0-9]/g,"").trim();if(!value)return null;try{const r=await fetch(`https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(value)}?fmt=json`,{headers:{Accept:"application/json","User-Agent":"dakshmusic3/1.0 (metadata-backfill)"}});if(!r.ok)return null;const d=await r.json();const rec=(d.recordings||[]).find(x=>Number(x.length)>0)||(d.recordings||[])[0];if(!rec?.id)return null;return{duration_ms:Number(rec.length)>0?Number(rec.length):null,method:"musicbrainz_isrc"};}catch{return null;}}
async function deezerMetadataByIsrc(isrc){const value=String(isrc||"").replace(/[^A-Za-z0-9]/g,"").trim();if(!value)return null;try{const r=await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(value)}`,{headers:{Accept:"application/json"}});if(!r.ok)return null;const d=await r.json();if(String(d?.isrc||"").replace(/[^A-Za-z0-9]/g,"").toUpperCase()!==value.toUpperCase())return null;return deezerMeta(d,"deezer_isrc");}catch{return null;}}
async function deezerMetadataByTrackId(trackId){const value=String(trackId||"").trim();if(!value)return null;try{const r=await fetch(`https://api.deezer.com/track/${encodeURIComponent(value)}`);if(!r.ok)return null;return deezerMeta(await r.json(),"track_id");}catch{return null;}}
async function deezerMetadataBySearch(title,artist,album){const cleanTitle=String(title||"").replace(/"/g,"").trim();try{let all=[];for(const q of [`track:"${cleanTitle}"`,cleanTitle]){if(!q)continue;const r=await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=25`);if(r.ok){const d=await r.json();all.push(...(d.data||[]));}}const seen=new Set();const candidates=all.filter(x=>x?.id&&!seen.has(x.id)&&seen.add(x.id));const titleExact=candidates.filter(x=>sameText(x.title,title));const artistExact=titleExact.filter(x=>artistMatches(x,artist));if(!artistExact.length)return null;const albumExact=album?artistExact.filter(x=>sameText(x.album?.title,album)):[];const pool=albumExact.length?albumExact:artistExact;if(pool.length!==1)return null;return deezerMeta(pool[0],albumExact.length?"title_artist_album":"title_artist");}catch{return null;}}
async function backfillMetadata(env,tracks){
  const stats={checked:tracks.length,by_deezer_isrc:0,by_musicbrainz_isrc:0,by_track_id:0,by_title_artist:0,enriched:0,unresolved:0,duration_filled:0,artwork_filled:0};
  const updates=[];
  for(let offset=0;offset<tracks.length;offset+=4){
    const chunk=tracks.slice(offset,offset+4);
    const settled=await Promise.all(chunk.map(async t=>{
      let duration=t.duration_ms>0?Number(t.duration_ms):null;
      let artwork=t.artwork_url||null;
      let sourceMethods=[];
      if(t.isrc){
        const dz=await deezerMetadataByIsrc(t.isrc);
        if(dz){stats.by_deezer_isrc++;sourceMethods.push("deezer_isrc");if(!duration&&dz.duration_ms)duration=dz.duration_ms;if(!artwork&&dz.artwork_url)artwork=dz.artwork_url;}
      }
      if(!duration&&t.isrc){
        const mb=await musicbrainzMetadataByIsrc(t.isrc);
        if(mb?.duration_ms){stats.by_musicbrainz_isrc++;sourceMethods.push("musicbrainz_isrc");duration=mb.duration_ms;}
      }
      if((!duration||!artwork)&&String(t.source||"").toLowerCase()==="deezer"&&t.source_id){
        const dz=await deezerMetadataByTrackId(t.source_id);
        if(dz){stats.by_track_id++;sourceMethods.push("track_id");if(!duration&&dz.duration_ms)duration=dz.duration_ms;if(!artwork&&dz.artwork_url)artwork=dz.artwork_url;}
      }
      if(!duration||!artwork){
        const search=await deezerMetadataBySearch(t.title,t.artist,t.album);
        if(search){if(!duration&&search.duration_ms)duration=search.duration_ms;if(!artwork&&search.artwork_url)artwork=search.artwork_url;if(search.artwork_url||search.duration_ms){stats.by_title_artist++;sourceMethods.push("title_artist");}}
      }
      return{t,duration,artwork,sourceMethods};
    }));
    for(const{t,duration,artwork}of settled){
      const durationToWrite=!(t.duration_ms>0)&&duration?Math.round(Number(duration)):null;
      const artworkToWrite=!t.artwork_url&&artwork?String(artwork):null;
      if(durationToWrite)stats.duration_filled++;
      if(artworkToWrite)stats.artwork_filled++;
      if(durationToWrite||artworkToWrite){
        stats.enriched++;
        updates.push(env.DB.prepare(`UPDATE tracks SET duration_ms=COALESCE(?,duration_ms),artwork_url=COALESCE(?,artwork_url),updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(durationToWrite,artworkToWrite,t.id));
      }else stats.unresolved++;
    }
  }
  for(let offset=0;offset<updates.length;offset+=100)await env.DB.batch(updates.slice(offset,offset+100));
  return stats;
}
async function syncPlaylistMetadata(env){
  await env.DB.prepare(`UPDATE playlist_entries SET artwork_url=(SELECT artwork_url FROM tracks WHERE tracks.id=playlist_entries.track_id),duration_ms=(SELECT duration_ms FROM tracks WHERE tracks.id=playlist_entries.track_id) WHERE EXISTS(SELECT 1 FROM tracks WHERE tracks.id=playlist_entries.track_id)`).run();
}
async function seed(env,req,ctx){
  if(!(await auth(env,req)))return json({error:"Authentication required"},401);
  let body;try{body=await req.json();}catch{return json({error:"Invalid JSON body"},400);}
  const items=Array.isArray(body?.items)?body.items.filter(x=>x?.title):[];if(!items.length)return json({error:"No tracks supplied"},400);
  await env.DB.prepare(`UPDATE tracks SET play_count=0`).run();await env.DB.prepare(`DELETE FROM playlist_entries`).run();await env.DB.prepare(`DELETE FROM top_played_cache`).run();
  for(let offset=0;offset<items.length;offset+=150){const chunk=items.slice(offset,offset+150);await env.DB.batch(chunk.map((x,i)=>{const sourceId=x.source_id?`apple:${String(x.source_id)}`:null;const sourceUrl=x.source_url||(x.source_id?`https://music.apple.com/us/song/${slug(x.title)}/${String(x.source_id)}`:null);return env.DB.prepare(`INSERT OR IGNORE INTO tracks(source,source_id,source_url,title,artist,album,duration_ms,isrc,artwork_url,natural_key,play_count) VALUES('apple',?,?,?,?,?,?,?,?,?,0)`).bind(sourceId,sourceUrl,x.title,x.artist||"",x.album||null,Number(x.duration_ms)||null,x.isrc||null,x.artwork_url||null,naturalKey(x,offset+i));}));}
  const{results:missing=[]}=await env.DB.prepare(`SELECT id,source,source_id,title,artist,album,isrc,duration_ms,artwork_url FROM tracks WHERE duration_ms IS NULL OR duration_ms<=0 OR artwork_url IS NULL OR artwork_url=''`).all();
  const metadata_backfill=await backfillMetadata(env,missing);
  const{results:sourceRows=[]}=await env.DB.prepare(`SELECT id,source_id,title FROM tracks WHERE source='apple' AND (source_url IS NULL OR source_url='') AND source_id IS NOT NULL`).all();
  if(sourceRows.length)for(let offset=0;offset<sourceRows.length;offset+=100){const chunk=sourceRows.slice(offset,offset+100);await env.DB.batch(chunk.map(t=>env.DB.prepare(`UPDATE tracks SET source_url=? WHERE id=?`).bind(`https://music.apple.com/us/song/${slug(t.title)}/${String(t.source_id).replace(/^apple:/,'')}`,t.id)));}
  const playlistRows=[];
  for(let offset=0;offset<items.length;offset+=100){const chunk=items.slice(offset,offset+100).filter(x=>x.source_id);if(!chunk.length)continue;const placeholders=chunk.map(()=>"?").join(",");const ids=chunk.map(x=>`apple:${String(x.source_id)}`);const{results}=await env.DB.prepare(`SELECT id,source_id,title,artist,album,artwork_url,duration_ms FROM tracks WHERE source_id IN (${placeholders})`).bind(...ids).all();const bySource=new Map((results||[]).map(r=>[r.source_id,r]));for(const x of chunk){const t=bySource.get(`apple:${String(x.source_id)}`);if(t)playlistRows.push(t);}}
  const byKey=new Map(playlistRows.map(t=>[t.source_id||`title:${t.title}|artist:${t.artist}|album:${t.album||""}`,t]));const ordered=[];for(let i=0;i<items.length;i++){const x=items[i];const key=x.source_id?`apple:${String(x.source_id)}`:`title:${x.title}|artist:${x.artist||""}|album:${x.album||""}`;const t=byKey.get(key);if(t&&!ordered.some(o=>o.id===t.id))ordered.push(t);}
  for(let offset=0;offset<ordered.length;offset+=150){const chunk=ordered.slice(offset,offset+150);await env.DB.batch(chunk.map((t,i)=>env.DB.prepare(`INSERT INTO playlist_entries(track_id,position,title,artist,album,artwork_url,duration_ms) VALUES(?,?,?,?,?,?,?)`).bind(t.id,offset+i+1,t.title,t.artist,t.album,t.artwork_url,t.duration_ms)));}
  await syncPlaylistMetadata(env);
  const topItems=items.filter(x=>String(x["100 Cache"]??x.cache??"").trim().toUpperCase()==="Y").slice(0,200);const topTracks=[];for(const x of topItems){const t=x.source_id?await env.DB.prepare(`SELECT id,title,artist FROM tracks WHERE source_id=?`).bind(`apple:${String(x.source_id)}`).first():await env.DB.prepare(`SELECT id,title,artist FROM tracks WHERE natural_key=?`).bind(naturalKey(x,items.indexOf(x))).first();if(t&&!topTracks.some(v=>v.id===t.id))topTracks.push(t);}if(topTracks.length)await env.DB.batch(topTracks.map((t,i)=>env.DB.prepare(`INSERT INTO top_played_cache(rank,track_id,storage_key,updated_at) VALUES(?,?,NULL,CURRENT_TIMESTAMP)`).bind(i+1,t.id)));
  return json({ok:true,playlist_entries:ordered.length,cache_entries:topTracks.length,cache_limit:200,top100:topTracks.map((t,i)=>({rank:i+1,track_id:t.id,title:t.title,artist:t.artist,play_count:0})),missing_count:items.length-ordered.length,play_counts_reset:true,metadata_backfill});
}
async function clearAll(env,req){if(!(await auth(env,req)))return json({error:"Authentication required"},401);try{await env.DB.batch([env.DB.prepare(`DELETE FROM album_cache`),env.DB.prepare(`DELETE FROM album_sessions`),env.DB.prepare(`DELETE FROM general_cache`),env.DB.prepare(`DELETE FROM top_played_cache`),env.DB.prepare(`DELETE FROM download_jobs`),env.DB.prepare(`DELETE FROM playlist_entries`),env.DB.prepare(`DELETE FROM tracks`),env.DB.prepare(`DELETE FROM albums`)]);return json({ok:true,cleared:["tracks","playlist_entries","top_played_cache","general_cache","download_jobs","album_cache","album_sessions","albums"],preserved:["sessions"]});}catch(error){console.error("clear-all failed",error);return json({error:`Clear-all failed: ${error?.message||error}`},500);}}
async function warmTopCache(env){const{results}=await env.DB.prepare(`SELECT t.id FROM top_played_cache c JOIN tracks t ON t.id=c.track_id WHERE c.storage_key IS NULL ORDER BY c.rank LIMIT 6`).all();for(const row of results||[]){try{await dispatchWarm(env,row.id);}catch(e){console.error("Top-cache warm failed",row.id,e);}}}
async function acquisitionStatus(env,req){if(!(await auth(env,req)))return json({error:"Authentication required"},401);const{results=[]}=await env.DB.prepare(`SELECT j.id,j.status,j.error,j.updated_at,j.track_id,t.title,t.artist,t.album FROM download_jobs j JOIN tracks t ON t.id=j.track_id WHERE j.status IN ('queued','dispatched','running','failed') ORDER BY j.updated_at DESC LIMIT 50`).all();return json({active:results.filter(x=>x.status!=="failed").map(x=>({id:x.id,status:x.status,title:x.title,artist:x.artist,album:x.album,updated_at:x.updated_at})),errors:results.filter(x=>x.status==="failed").map(x=>({id:x.id,title:x.title,artist:x.artist,album:x.album,error:x.error||"Acquisition failed",updated_at:x.updated_at}))});}
export async function scheduled(env){await warmTopCache(env);}export async function handleLibraryV2(req,env,ctx){const url=new URL(req.url);if(url.pathname==="/api/v1/admin/clear-all"&&req.method==="POST")return clearAll(env,req);if(url.pathname==="/api/v1/library/seed"&&req.method==="POST")return seed(env,req,ctx);if(url.pathname==="/api/v1/jobs/status"&&req.method==="GET")return acquisitionStatus(env,req);return null;}

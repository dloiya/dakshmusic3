const MIN_BYTES=1024;
const emit=(type,data={})=>postMessage({type,...data});
const isHttp=x=>typeof x==='string'&&/^https?:\/\//i.test(x);
const mediaLike=x=>/\.(flac|mp3|m4a|aac|ogg|opus|webm|wav)(?:[?#]|$)/i.test(x||'');

async function get(url,stage){
  emit('progress',{stage});
  const r=await fetch(url,{redirect:'follow'});
  if(!r.ok)throw Error(`${stage} failed: HTTP ${r.status}`);
  return r;
}

async function fetchMedia(url,name){
  const r=await get(url,'downloading audio');
  const blob=await r.blob();
  if(blob.size<MIN_BYTES)throw Error('Acquired audio is too small');
  return {blob,mime:blob.type||'application/octet-stream',name};
}

function youtubeId(url){
  try{
    const u=new URL(url);
    if(u.hostname==='youtu.be')return u.pathname.slice(1);
    if(u.hostname.includes('youtube.com'))return u.searchParams.get('v')||u.pathname.split('/').filter(Boolean).pop();
  }catch{}
  return null;
}

async function resolveYtDlp(job){
  // A browser cannot execute Python/yt-dlp. This resolver follows the same
  // contract: resolve a watch URL to the best audio stream, then return bytes.
  const source=job.media_url||job.resolved_url;
  if(isHttp(source)&&mediaLike(source))return fetchMedia(source,'yt-dlp: downloading resolved audio');

  const id=youtubeId(job.url||'');
  if(!id)throw Error('yt-dlp provider needs a YouTube URL or a resolved media_url');

  // Self-hostable extractor API. Set window.DAKSH_EXTRACTOR_URL before loading
  // the worker, or include extractor_url on the job. The API returns either
  // {url,mime} or {formats:[{url,mimeType,bitrate,contentLength}]}.
  const base=job.extractor_url||self.DAKSH_EXTRACTOR_URL;
  if(!base)throw Error('No browser extractor configured for this YouTube job');
  const endpoint=`${base.replace(/\/$/,'')}/resolve?url=${encodeURIComponent(job.url)}`;
  const r=await get(endpoint,'yt-dlp: resolving formats');
  const data=await r.json();
  const formats=Array.isArray(data.formats)?data.formats:[];
  const candidates=[...(data.url?[data]:[]),...formats]
    .filter(x=>isHttp(x.url))
    .filter(x=>!x.hasVideo||x.audioOnly||String(x.mimeType||x.mime||'').startsWith('audio/'))
    .sort((a,b)=>(Number(b.bitrate)||0)-(Number(a.bitrate)||0));
  if(!candidates.length)throw Error('Extractor returned no usable audio format');
  return fetchMedia(candidates[0].url,'yt-dlp: downloading bestaudio');
}

async function deezerMetadata(url){
  const m=url.match(/deezer\.com\/(?:[a-z-]+\/)?track\/(\d+)/i);
  if(!m)return null;
  const r=await get(`https://api.deezer.com/track/${m[1]}`,'mdl: resolving Deezer metadata');
  const d=await r.json();
  return {title:d.title,artist:d.artist?.name,album:d.album?.title,isrc:d.isrc,source:'deezer'};
}

async function spotifyMetadata(url){
  const r=await get(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,'mdl: resolving Spotify metadata');
  const d=await r.json();
  const text=d.title||'';
  const parts=text.split(' - ');
  return {title:parts[0]||text,artist:parts.slice(1).join(' - '),source:'spotify'};
}

async function resolveMDL(job){
  const direct=job.media_url||job.resolved_url;
  if(isHttp(direct)&&mediaLike(direct))return fetchMedia(direct,'mdl: downloading resolved audio');
  let meta={title:job.title,artist:job.artist,album:job.album,isrc:job.isrc,source_url:job.url};
  const url=job.url||'';
  if(/deezer\.com/i.test(url))meta={...meta,...await deezerMetadata(url)};
  else if(/open\.spotify\.com/i.test(url))meta={...meta,...await spotifyMetadata(url)};
  if(!meta.title)throw Error('MDL provider could not resolve track metadata');

  // MDL-style resolver: metadata in, playable audio URL out. This endpoint can
  // be implemented independently of the browser and replaced without changing
  // the queue, worker, transcoder, or R2 pipeline.
  const base=job.resolver_url||self.DAKSH_RESOLVER_URL;
  if(!base)throw Error('No MDL resolver configured for this source');
  const r=await get(`${base.replace(/\/$/,'')}/resolve`,'mdl: finding matching audio');
  // Retry as POST when the resolver expects the metadata body.
  let data;
  try{data=await r.json()}catch{throw Error('MDL resolver returned invalid JSON')}
  const candidates=Array.isArray(data.candidates)?data.candidates:(data.url?[data]:[]);
  const best=candidates.filter(x=>isHttp(x.url)).sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0))[0];
  if(!best)throw Error('MDL resolver returned no playable audio');
  return fetchMedia(best.url,'mdl: downloading best match');
}

async function acquire(job){
  const provider=(job.provider||'auto').toLowerCase();
  if(isHttp(job.media_url)&&mediaLike(job.media_url))return fetchMedia(job.media_url,'downloading supplied media');
  if(provider==='direct'||(provider==='auto'&&mediaLike(job.url)))return fetchMedia(job.url,'downloading direct media');
  const errors=[];
  const attempt=async(name,fn)=>{try{return await fn()}catch(e){errors.push(`${name}: ${e.message||e}`);emit('progress',{stage:`${name} failed; trying fallback`});return null}};
  if(provider==='mdl'){
    const x=await attempt('MDL',()=>resolveMDL(job));if(x)return x;
    const y=await attempt('yt-dlp',()=>resolveYtDlp(job));if(y)return y;
  }else if(provider==='yt-dlp'||youtubeId(job.url||'')){
    const x=await attempt('yt-dlp',()=>resolveYtDlp(job));if(x)return x;
    const y=await attempt('MDL',()=>resolveMDL(job));if(y)return y;
  }else{
    const x=await attempt('MDL',()=>resolveMDL(job));if(x)return x;
    const y=await attempt('yt-dlp',()=>resolveYtDlp(job));if(y)return y;
  }
  throw Error(errors.join(' | ')||'All acquisition providers failed');
}

onmessage=async({data})=>{
  if(data.type!=='acquire')return;
  try{
    emit('progress',{stage:'selecting acquisition provider'});
    const result=await acquire(data.job||{});
    emit('result',result);
  }catch(e){emit('error',{error:e.message||String(e)})}
};

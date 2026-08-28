let seq=0;
const emit=(type,data={})=>postMessage({type,...data});
const DIRECT=/\.(?:flac|mp3|m4a|aac|ogg|opus|wav|webm)(?:$|[?#])/i;
const YOUTUBE=/(?:youtube\.com|youtu\.be|music\.youtube\.com)/i;
const MDL_HOSTS=/(?:open\.spotify\.com|music\.apple\.com|music\.amazon\.|music\.youtube\.com|youtube\.com|youtu\.be|soundcloud\.com|bandcamp\.com|qobuz\.com|deezer\.com|tidal\.com)/i;

function requireUrl(value,name='url'){
  let u;try{u=new URL(value)}catch{throw Error(`${name} must be an absolute URL`)}
  if(!/^https?:$/.test(u.protocol))throw Error(`${name} must use http or https`);
  return u.toString();
}

async function fetchAudio(url,label){
  emit('progress',{stage:`${label}: downloading audio`});
  const r=await fetch(requireUrl(url),{redirect:'follow',credentials:'omit'});
  if(!r.ok)throw Error(`${label}: source request failed (${r.status})`);
  const blob=await r.blob();
  if(blob.size<1024)throw Error(`${label}: source is too small`);
  return {blob,mime:blob.type||'application/octet-stream',name:`source-${++seq}`};
}

async function acquireDirect(job){
  return fetchAudio(job.media_url||job.resolved_url||job.url,'direct provider');
}

// Browser-side contract equivalent to yt-dlp's input stage. A resolver may be
// supplied by the coordinator/provider and must return a browser-fetchable media URL.
async function acquireYtDlp(job){
  const resolved=job.media_url||job.resolved_url;
  if(resolved)return fetchAudio(resolved,'yt-dlp provider');
  if(!YOUTUBE.test(job.url||''))throw Error('yt-dlp provider requires a YouTube URL');
  throw Error('yt-dlp provider needs a resolved browser-fetchable media URL; native yt-dlp cannot execute inside this browser worker');
}

// MDL-compatible provider contract: streaming-service URL -> resolved media URL.
// The actual CLI command is intentionally not invoked here because browsers cannot
// spawn npx/Node processes. If the coordinator supplies resolved_url/media_url,
// the browser performs the same downstream acquisition -> FLAC pipeline.
async function acquireMDL(job){
  const resolved=job.media_url||job.resolved_url;
  if(resolved)return fetchAudio(resolved,'MDL provider');
  if(!MDL_HOSTS.test(job.url||''))throw Error('MDL provider received an unsupported URL');
  throw Error('MDL provider needs a resolved browser-fetchable media URL; @mdlx/cli cannot execute natively in a browser worker');
}

async function acquire(job){
  if(!job||!job.url)throw Error('Job URL is required');
  const provider=(job.provider||'auto').toLowerCase();
  if(provider==='direct')return acquireDirect(job);
  if(provider==='yt-dlp'||provider==='ytdlp')return acquireYtDlp(job);
  if(provider==='mdl'||provider==='musicdl')return acquireMDL(job);

  if(job.media_url||job.resolved_url||DIRECT.test(job.url))return acquireDirect(job);
  if(YOUTUBE.test(job.url))return acquireYtDlp(job);
  if(MDL_HOSTS.test(job.url))return acquireMDL(job);
  return acquireDirect(job);
}

onmessage=async({data})=>{
  if(data.type!=='acquire')return;
  try{
    emit('progress',{stage:'selecting provider'});
    const result=await acquire(data.job);
    emit('result',result);
  }catch(e){emit('error',{error:e?.message||String(e)})}
};

const H={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
const json=(x,s=200)=>Response.json(x,{status:s,headers:H});
const err=(m,s=400)=>json({error:m},s);

export default {async fetch(req,env){
 if(req.method==='OPTIONS')return new Response(null,{headers:H});
 const u=new URL(req.url),p=u.pathname;
 if(req.method==='GET'&&p==='/health')return json({ok:true,service:'dakshmusic3-coordinator'});

 // Queue an existing track. The production D1 schema keeps provider metadata on tracks,
 // while acquisition_jobs stores only the track_id and job lifecycle state.
 if(req.method==='POST'&&p==='/api/jobs'){
  const b=await req.json().catch(()=>({}));
  let track=null;
  if(b.track_id!=null)track=await env.DB.prepare('SELECT id,title,artist,album_name,source,source_id,source_url,isrc,storage_key,storage_status FROM tracks WHERE id=?1').bind(Number(b.track_id)).first();
  else if(b.url)track=await env.DB.prepare('SELECT id,title,artist,album_name,source,source_id,source_url,isrc,storage_key,storage_status FROM tracks WHERE source_url=?1 LIMIT 1').bind(String(b.url)).first();
  if(!track)return err('track not found in existing tracks table',404);
  if(track.storage_status==='complete'&&track.storage_key)return json({status:'complete',track_id:track.id,already_acquired:true});
  const existing=await env.DB.prepare("SELECT id,status,attempts FROM acquisition_jobs WHERE track_id=?1 AND status IN ('queued','processing') ORDER BY created_at DESC LIMIT 1").bind(track.id).first();
  if(existing)return json({id:existing.id,track_id:track.id,status:existing.status,attempts:existing.attempts});
  const id=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO acquisition_jobs(id,track_id,status,worker,attempts,created_at,updated_at) VALUES(?1,?2,'queued',NULL,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id,track.id).run();
  return json({id,track_id:track.id,status:'queued'},201);
 }

 if(req.method==='POST'&&p==='/api/jobs/claim'){
  const browser=(await req.json().catch(()=>({}))).browser_id||crypto.randomUUID();
  const candidate=await env.DB.prepare("SELECT id FROM acquisition_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").first();
  if(!candidate)return json({job:null});
  await env.DB.prepare("UPDATE acquisition_jobs SET status='processing',worker=?1,attempts=attempts+1,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status='queued'").bind(browser,candidate.id).run();
  const row=await env.DB.prepare("SELECT j.id,j.track_id,j.attempts,t.title,t.artist,t.album_name,t.source,t.source_id,t.source_url,t.isrc FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id WHERE j.id=?1 AND j.status='processing' AND j.worker=?2").bind(candidate.id,browser).first();
  return json({job:row||null});
 }

 if(req.method==='POST'&&/^\/api\/jobs\/[^/]+\/upload$/.test(p)){
  const id=p.split('/')[3],b=await req.json().catch(()=>({}));
  const job=await env.DB.prepare("SELECT id,track_id,worker,status FROM acquisition_jobs WHERE id=?1").bind(id).first();
  if(!job||job.status!=='processing')return err('job is not active',409);
  if(b.browser_id&&job.worker!==b.browser_id)return err('job owned by another browser',403);
  if(!env.R2_ENDPOINT||!env.R2_ACCESS_KEY_ID||!env.R2_SECRET_ACCESS_KEY)return err('R2 presigning is not configured',503);
  const key=`audio/tracks/${job.track_id}.flac`,url=new URL(`${env.R2_ENDPOINT.replace(/\/$/,'')}/${env.R2_BUCKET||'dakshmusic3-audio'}/${key}`);url.searchParams.set('X-Amz-Expires','900');
  const {AwsClient}=await import('aws4fetch');
  const aws=new AwsClient({accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY});
  const signed=await aws.sign(new Request(url,{method:'PUT',headers:{'Content-Type':'audio/flac'}}),{aws:{signQuery:true,region:'auto',service:'s3'}});
  return json({url:signed.url,key,expires_in:900,content_type:'audio/flac'});
 }

 if(req.method==='POST'&&/^\/api\/jobs\/[^/]+\/complete$/.test(p)){
  const id=p.split('/')[3],b=await req.json().catch(()=>({}));
  if(!b.storage_key)return err('storage_key required');
  const job=await env.DB.prepare("SELECT id,track_id,worker,status FROM acquisition_jobs WHERE id=?1").bind(id).first();
  if(!job||job.status!=='processing')return err('job is not active',409);
  if(b.browser_id&&job.worker!==b.browser_id)return err('job owned by another browser',403);
  await env.DB.batch([
   env.DB.prepare("UPDATE tracks SET storage_key=?1,storage_status='complete',duration_ms=COALESCE(?2,duration_ms),updated_at=CURRENT_TIMESTAMP WHERE id=?3").bind(b.storage_key,b.duration_ms==null?null:Number(b.duration_ms),job.track_id),
   env.DB.prepare("UPDATE acquisition_jobs SET status='complete',error=NULL,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?1").bind(id)
  ]);
  return json({ok:true,track_id:job.track_id});
 }

 if(req.method==='POST'&&/^\/api\/jobs\/[^/]+\/fail$/.test(p)){
  const id=p.split('/')[3],b=await req.json().catch(()=>({}));
  const job=await env.DB.prepare("SELECT id,attempts,worker,status FROM acquisition_jobs WHERE id=?1").bind(id).first();
  if(!job||job.status!=='processing')return err('job is not active',409);
  if(b.browser_id&&job.worker!==b.browser_id)return err('job owned by another browser',403);
  const next=Number(job.attempts)>=3?'failed':'queued';
  await env.DB.prepare("UPDATE acquisition_jobs SET status=?1,error=?2,worker=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?3").bind(next,String(b.error||'failed').slice(0,4000),id).run();
  return json({ok:true,status:next,attempts:job.attempts});
 }

 if(req.method==='GET'&&p==='/api/jobs')return json({jobs:(await env.DB.prepare('SELECT j.*,t.title,t.artist,t.album_name,t.source,t.source_url,t.storage_key,t.storage_status FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id ORDER BY j.created_at DESC LIMIT 100').all()).results});
 return err('not found',404);
}};

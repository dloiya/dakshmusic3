import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const API = (process.env.DAKSH_API_URL || '').replace(/\/$/, '');
const POLL_MS = Number(process.env.POLL_MS || 3000);
const ROOT = path.join(os.tmpdir(), 'dakshmusic3-acquire');

if (!API) throw new Error('DAKSH_API_URL is required');
await fs.mkdir(ROOT, { recursive: true });

const run = (cmd, args, cwd, timeout = 30 * 60 * 1000) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { cwd, shell: false, stdio: ['ignore','pipe','pipe'] });
  let out = '', err = '';
  p.stdout.on('data', x => { out += x; process.stdout.write(x); });
  p.stderr.on('data', x => { err += x; process.stderr.write(x); });
  const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeout);
  p.on('error', reject);
  p.on('close', code => { clearTimeout(timer); code === 0 ? resolve({out,err}) : reject(new Error(`${cmd} exited ${code}: ${(err || out).slice(-4000)}`)); });
});

const claim = async () => {
  const r = await fetch(`${API}/api/jobs/claim`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({worker:`oracle-${os.hostname()}`}) });
  if (!r.ok) throw new Error(`claim ${r.status}: ${await r.text()}`);
  return (await r.json()).job;
};

const upload = async (job, file) => {
  const body = await fs.readFile(file);
  const r = await fetch(`${API}/api/jobs/${job.id}/upload`, { method:'PUT', headers:{'content-type':'audio/flac'}, body });
  if (!r.ok) throw new Error(`upload ${r.status}: ${await r.text()}`);
};

const fail = async (job, error) => {
  try { await fetch(`${API}/api/jobs/${job.id}/fail`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({error:String(error?.message || error)}) }); } catch {}
};

const flac = async dir => {
  const files = (await fs.readdir(dir)).filter(x => x.toLowerCase().endsWith('.flac'));
  if (!files.length) throw new Error('No FLAC produced');
  let best = files[0], mt = 0;
  for (const f of files) { const s = await fs.stat(path.join(dir,f)); if (s.mtimeMs > mt) { mt=s.mtimeMs; best=f; } }
  return path.join(dir,best);
};

async function acquire(job) {
  const dir = path.join(ROOT, job.id); await fs.rm(dir,{recursive:true,force:true}); await fs.mkdir(dir,{recursive:true});
  const url = job.source_url || '';
  if (!url) throw new Error('No source_url');

  // MDL is tried first with the original provider URL. It supports streaming-service URLs.
  try {
    console.log(`Job ${job.id}: MDL ${url}`);
    await run('npx', ['--yes','@mdlx/cli',url,'--output',dir,'--parallel','1','--format','flac','--bitrate','best','--no-po-token'], dir);
    const f = await flac(dir); return f;
  } catch (e) {
    console.log(`Job ${job.id}: MDL failed: ${e.message}`);
  }

  // Fallback: yt-dlp must receive a YouTube URL, so search YouTube from canonical metadata.
  const query = `${job.artist || ''} - ${job.title || ''}`.trim();
  if (!query || query === '-') throw new Error('No metadata for YouTube fallback');
  console.log(`Job ${job.id}: yt-dlp search ${query}`);
  await run('yt-dlp', [`ytsearch1:${query}`,'--no-playlist','-x','--audio-format','flac','--audio-quality','0','--output',path.join(dir,'%(title)s.%(ext)s'),'--no-warnings','--retries','3','--extractor-retries','3'], dir);
  return flac(dir);
}

while (true) {
  try {
    const job = await claim();
    if (!job) { await new Promise(r=>setTimeout(r,POLL_MS)); continue; }
    console.log(`Claimed ${job.id}: ${job.title || 'Unknown'} / ${job.artist || 'Unknown'}`);
    try { const file = await acquire(job); await upload(job,file); console.log(`Completed ${job.id}`); }
    catch (e) { console.error(`Failed ${job.id}:`,e); await fail(job,e); }
  } catch (e) { console.error('Poll error:',e); await new Promise(r=>setTimeout(r,Math.max(POLL_MS,5000))); }
}

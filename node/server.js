import express from 'express';
import cors from 'cors';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 9876;
const COORD = process.env.COORDINATOR_URL || '';

let state = {
  running: false,
  current: null,
  completed: 0,
  failed: 0,
  lastError: null,
  process: null,
  workerId: crypto.randomUUID(),
  polling: false,
};

const bin = (x) =>
  spawnSync(x, ['--version'], { shell: true, encoding: 'utf8' }).status === 0;

function isYouTubeUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com';
  } catch {
    return false;
  }
}

function safeName(value) {
  return String(value || 'track')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'track';
}

function jobSearchQuery(job) {
  const artist = String(job.artist || '').trim();
  const title = String(job.title || '').trim();
  if (!artist && !title) throw new Error('Job has no artist/title metadata for YouTube search');
  return [artist, title].filter(Boolean).join(' - ');
}

async function spawnAndWait(command, args, cwd) {
  if (state.process) throw new Error('node busy');

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    state.process = child;
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      state.process = null;
      reject(err);
    });

    child.on('close', (code) => {
      state.process = null;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = (stderr || stdout).trim().slice(-4000);
        reject(new Error(`${command} exited ${code}${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}

async function acquireYouTube(url, output) {
  fs.mkdirSync(output, { recursive: true });
  return spawnAndWait(
    'yt-dlp',
    [
      url,
      '--no-playlist',
      '--format', 'bestaudio/best',
      '--extract-audio',
      '--audio-format', 'flac',
      '--audio-quality', '0',
      '--embed-metadata',
      '--output', path.join(output, '%(title)s.%(ext)s'),
      '--no-progress',
      '--newline',
    ],
    output,
  );
}

async function acquireBySearch(job, output) {
  fs.mkdirSync(output, { recursive: true });

  const query = jobSearchQuery(job);
  console.log(`Job ${job.id}: YouTube search: ${query}`);

  return spawnAndWait(
    'yt-dlp',
    [
      `ytsearch1:${query}`,
      '--no-playlist',
      '--format', 'bestaudio/best',
      '--extract-audio',
      '--audio-format', 'flac',
      '--audio-quality', '0',
      '--embed-metadata',
      '--output', path.join(output, '%(title)s.%(ext)s'),
      '--no-progress',
      '--newline',
    ],
    output,
  );
}

function findFlac(output) {
  const files = fs
    .readdirSync(output, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.flac'))
    .map((entry) => path.join(output, entry.name));

  if (!files.length) throw new Error('yt-dlp completed but no FLAC file was produced');
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

async function uploadToCoordinator(jobId, browserId, filePath) {
  const response = await fetch(`${COORD}/api/jobs/${jobId}/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ browser_id: browserId }),
  });

  if (!response.ok) {
    throw new Error(`R2 upload URL request failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
  }

  const signed = await response.json();
  if (!signed.url || !signed.key) throw new Error('Coordinator returned an invalid R2 upload response');

  const body = fs.createReadStream(filePath);
  const put = await fetch(signed.url, {
    method: 'PUT',
    headers: { 'Content-Type': signed.content_type || 'audio/flac' },
    body,
    duplex: 'half',
  });

  if (!put.ok) {
    throw new Error(`R2 upload failed (${put.status}): ${(await put.text()).slice(0, 1000)}`);
  }

  return signed.key;
}

async function completeJob(job, storageKey, durationMs = null) {
  const response = await fetch(`${COORD}/api/jobs/${job.id}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      browser_id: state.workerId,
      storage_key: storageKey,
      duration_ms: durationMs,
    }),
  });

  if (!response.ok) {
    throw new Error(`Coordinator complete failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
  }
}

async function failJob(job, error) {
  try {
    await fetch(`${COORD}/api/jobs/${job.id}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        browser_id: state.workerId,
        error: String(error?.message || error || 'failed'),
      }),
    });
  } catch (e) {
    state.lastError = `Coordinator fail request: ${e.message}`;
  }
}

async function acquireJob(job) {
  const sourceUrl = job.source_url || job.url;
  if (!sourceUrl) throw new Error('Job has no source_url');

  const output = path.resolve('downloads', String(job.id));
  fs.mkdirSync(output, { recursive: true });

  // MDL's non-YouTube acquisition path currently resolves Deezer/etc. metadata
  // but can hand the original source URL to its yt-dlp provider. That produces
  // "yt-dlp provider needs a YouTube URL". For source metadata providers, use
  // yt-dlp's YouTube search directly with the coordinator's canonical metadata.
  if (isYouTubeUrl(sourceUrl)) {
    console.log(`Job ${job.id}: downloading supplied YouTube URL`);
    await acquireYouTube(sourceUrl, output);
  } else {
    await acquireBySearch(job, output);
  }

  const flac = findFlac(output);
  const stat = fs.statSync(flac);
  console.log(`Job ${job.id}: produced ${path.basename(flac)} (${stat.size} bytes)`);

  const storageKey = await uploadToCoordinator(job.id, state.workerId, flac);
  await completeJob(job, storageKey);

  return { storageKey, file: flac };
}

async function poll() {
  if (!COORD || state.running) return;

  try {
    const response = await fetch(`${COORD}/api/jobs/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ browser_id: state.workerId }),
    });

    if (!response.ok) throw new Error(`Coordinator claim failed (${response.status})`);

    const { job } = await response.json();
    if (!job) return;

    state.running = true;
    state.current = job.source_url || job.url || job.id;
    state.lastError = null;

    console.log(`Claimed ${job.id} — ${job.title || 'Unknown'} / ${job.artist || 'Unknown'}`);

    try {
      await acquireJob(job);
      state.completed++;
      console.log(`Completed ${job.id}`);
    } catch (e) {
      state.failed++;
      state.lastError = e.message;
      console.error(`Failed ${job.id}: ${e.message}`);
      await failJob(job, e);
    } finally {
      state.running = false;
      state.current = null;
    }
  } catch (e) {
    state.lastError = `Coordinator: ${e.message}`;
    console.error(state.lastError);
  }
}

app.get('/api/status', (q, s) =>
  s.json({
    ...state,
    process: undefined,
    coordinator: COORD,
    capabilities: {
      node: process.version,
      ffmpeg: bin('ffmpeg'),
      npx: bin('npx'),
      ytdlp: bin('yt-dlp'),
    },
  }),
);

app.post('/api/acquire', async (q, s) => {
  try {
    if (state.process || state.running) return s.status(409).json({ error: 'node busy' });
    const url = q.body?.url;
    if (!url) return s.status(400).json({ error: 'url is required' });
    acquireJob({ id: crypto.randomUUID(), source_url: url, title: q.body?.title, artist: q.body?.artist })
      .catch((e) => console.error(`Manual acquisition failed: ${e.message}`));
    s.status(202).json({ accepted: true });
  } catch (e) {
    s.status(409).json({ error: e.message });
  }
});

app.post('/api/stop', (q, s) => {
  if (state.process) {
    state.process.kill();
    return s.json({ stopped: true });
  }
  s.json({ stopped: false });
});

app.listen(PORT, () => {
  console.log(`DakshMusic node http://127.0.0.1:${PORT}`);
  console.log(`Worker ID: ${state.workerId}`);
  setInterval(poll, 5000);
  poll();
});

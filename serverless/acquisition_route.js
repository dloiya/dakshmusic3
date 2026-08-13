const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

function cookie(req) {
  return (req.headers.get("Cookie") || "").match(/(?:^|;\s*)music_session=([^;]+)/)?.[1] || null;
}

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function auth(env, req) {
  const token = cookie(req);
  if (!token) return false;
  const row = await env.DB.prepare(`SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?`)
    .bind(await sha256(token), Math.floor(Date.now() / 1000)).first();
  return !!row;
}

async function durationFromCatalog(track) {
  const sourceId = String(track.source_id || "").trim();
  const naturalKey = String(track.natural_key || "");
  const appleId = sourceId.match(/^apple[-_:](\d+)$/i)?.[1] || naturalKey.match(/^apple[-_:](\d+)\b/i)?.[1] || null;

  // Apple ID lookup, even when the imported row has subsequently been
  // mapped to a Deezer source.
  if (appleId) {
    try {
      const r = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appleId)}&entity=song`);
      if (r.ok) {
        const d = await r.json();
        const hit = (d.results || []).find(x => x.wrapperType === "track" && Number(x.trackTimeMillis) > 0);
        if (hit) return Number(hit.trackTimeMillis);
      }
    } catch {}
  }

  // Metadata lookup. Prefer exact title/artist, then a close title match.
  if (track.title && track.artist) {
    try {
      const term = encodeURIComponent(`${track.title} ${track.artist}`);
      const r = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=25`);
      if (r.ok) {
        const d = await r.json();
        const title = String(track.title).toLowerCase().trim();
        const artist = String(track.artist).toLowerCase().trim();
        const results = (d.results || []).filter(x => Number(x.trackTimeMillis) > 0);
        const exact = results.find(x => String(x.trackName || "").toLowerCase().trim() === title && String(x.artistName || "").toLowerCase().trim() === artist);
        if (exact) return Number(exact.trackTimeMillis);
        const close = results.find(x => String(x.trackName || "").toLowerCase().trim().includes(title) || title.includes(String(x.trackName || "").toLowerCase().trim()));
        if (close) return Number(close.trackTimeMillis);
      }
    } catch {}
  }

  // Deezer provider fallback.
  if (sourceId && /^\d+$/.test(sourceId)) {
    try {
      const r = await fetch(`https://api.deezer.com/track/${encodeURIComponent(sourceId)}`);
      if (r.ok) {
        const d = await r.json();
        if (Number(d?.duration) > 0) return Number(d.duration) * 1000;
      }
    } catch {}
  }

  if (track.source_url) {
    const m = String(track.source_url).match(/deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/i);
    if (m) {
      try {
        const r = await fetch(`https://api.deezer.com/track/${m[1]}`);
        if (r.ok) {
          const d = await r.json();
          if (Number(d?.duration) > 0) return Number(d.duration) * 1000;
        }
      } catch {}
    }
  }

  return null;
}

export async function handleAcquisitionRoute(req, env) {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/v1\/tracks\/([0-9]+)\/acquire$/);
  if (!match || req.method !== "POST") return null;
  if (!(await auth(env, req))) return json({ error: "Authentication required" }, 401);

  const trackId = Number(match[1]);
  const track = await env.DB.prepare(`SELECT * FROM tracks WHERE id=?`).bind(trackId).first();
  if (!track) return json({ error: "Track not found" }, 404);
  if (!track.source_url) return json({ error: "Track has no source URL to acquire from" }, 400);

  const cached = await env.DB.prepare(`SELECT drive_file_id FROM general_cache WHERE track_id=?`).bind(trackId).first();
  if (cached?.drive_file_id) return json({ cached: true, track_id: trackId, drive_file_id: cached.drive_file_id });

  const existing = await env.DB.prepare(`SELECT id FROM download_jobs WHERE track_id=? AND status IN ('queued','dispatched','running') ORDER BY created_at DESC LIMIT 1`).bind(trackId).first();
  if (existing) return json({ cached: false, track_id: trackId, job_id: existing.id });

  let duration = Number(track.duration_ms) || 0;
  if (!duration) duration = await durationFromCatalog(track) || 0;

  if (!duration) {
    return json({ error: `Track ${track.natural_key || trackId} has no canonical duration_ms; refusing acquisition without identity data` }, 502);
  }

  await env.DB.prepare(`UPDATE tracks SET duration_ms=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (duration_ms IS NULL OR duration_ms=0)`).bind(duration, trackId).run();

  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    return json({ error: "GitHub Actions dispatch is not configured" }, 500);
  }

  const jobId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO download_jobs(id,track_id,kind,status) VALUES(?,?,?,'queued')`).bind(jobId, trackId, "general").run();

  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/acquire-audio.yml/dispatches`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "personal-music-server", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId, source_url: track.source_url, title: track.title, artist: track.artist || "", album: track.album || "", duration_ms: String(duration) } }),
  });

  if (!response.ok) {
    const text = await response.text();
    await env.DB.prepare(`UPDATE download_jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(text, jobId).run();
    return json({ error: `GitHub acquisition dispatch failed: ${response.status}` }, 502);
  }

  await env.DB.prepare(`UPDATE download_jobs SET status='dispatched',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(jobId).run();
  return json({ cached: false, track_id: trackId, job_id: jobId, duration_ms: duration });
}

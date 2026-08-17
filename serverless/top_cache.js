const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function cookie(req) {
  return (req.headers.get("Cookie") || "").match(/(?:^|;\s*)music_session=([^;]+)/)?.[1] || null;
}

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function auth(env, req) {
  const token = cookie(req);
  if (!token || !env.DB) return false;
  return !!await env.DB.prepare(`SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?`)
    .bind(await sha256(token), Math.floor(Date.now() / 1000)).first();
}

async function dispatch(env, track) {
  const existing = await env.DB.prepare(`SELECT id FROM download_jobs WHERE track_id=? AND status IN ('queued','dispatched','running') ORDER BY created_at DESC LIMIT 1`).bind(track.id).first();
  if (existing) return { status: "existing", job_id: existing.id };
  if (!track.source_url) return { status: "skipped", reason: "missing source URL" };
  if (!track.duration_ms || Number(track.duration_ms) <= 0) return { status: "skipped", reason: "missing duration" };
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error("GitHub Actions dispatch is not configured");

  const jobId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO download_jobs(id,track_id,kind,status) VALUES(?,?,?,'queued')`).bind(jobId, track.id, "general").run();
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/acquire-audio.yml/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "dakshmusic3",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: {
      job_id: jobId,
      source_url: track.source_url,
      title: track.title || "",
      artist: track.artist || "",
      album: track.album || "",
      duration_ms: String(track.duration_ms),
    }}),
  });

  if (!response.ok) {
    const text = await response.text();
    const error = `GitHub dispatch ${response.status}: ${text.slice(0, 500)}`;
    await env.DB.prepare(`UPDATE download_jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(error, jobId).run();
    return { status: "failed", job_id: jobId, reason: error };
  }
  await env.DB.prepare(`UPDATE download_jobs SET status='dispatched',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(jobId).run();
  return { status: "dispatched", job_id: jobId };
}

export async function populateTopCache(env, req) {
  if (!(await auth(env, req))) return json({ error: "Authentication required" }, 401);

  const { results = [] } = await env.DB.prepare(`
    SELECT c.rank, c.track_id, c.storage_key, t.title, t.artist, t.album, t.source_url, t.duration_ms
    FROM top_played_cache c
    JOIN tracks t ON t.id=c.track_id
    ORDER BY c.rank ASC
    LIMIT 200
  `).all();

  if (!results.length) return json({ ok: false, error: "Top Cache is empty. Import the Excel/library first." }, 400);

  let dispatched = 0, existing = 0, skipped = 0, failed = 0, cached = 0;
  const errors = [];
  for (const track of results) {
    if (track.storage_key) { cached++; continue; }
    try {
      const result = await dispatch(env, track);
      if (result.status === "dispatched") dispatched++;
      else if (result.status === "existing") existing++;
      else if (result.status === "skipped") skipped++;
      else if (result.status === "failed") { failed++; errors.push({ track_id: track.track_id, title: track.title, reason: result.reason }); }
    } catch (error) {
      failed++;
      errors.push({ track_id: track.track_id, title: track.title, reason: String(error?.message || error) });
    }
  }

  return json({
    ok: failed === 0,
    message: `Top Cache: ${dispatched} dispatched, ${existing} already running, ${cached} already cached, ${skipped} skipped, ${failed} failed.`,
    total: results.length,
    dispatched,
    existing,
    cached,
    skipped,
    failed,
    errors: errors.slice(0, 20),
  }, failed ? 207 : 200);
}

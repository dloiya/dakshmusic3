import worker from "./worker.js";

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...extra },
});

function cookie(req) {
  return (req.headers.get("Cookie") || "").match(/(?:^|;\s*)music_session=([^;]+)/)?.[1] || null;
}

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function requireAuth(env, req) {
  const token = cookie(req);
  if (!token || !env.DB) return false;
  const row = await env.DB.prepare(`SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?`).bind(await sha256(token), Math.floor(Date.now() / 1000)).first();
  return !!row;
}

async function listAcquisitions(env, req) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  const status = url.searchParams.get("status");
  const sql = status
    ? `SELECT j.id AS job_id,j.track_id,j.kind,j.status,j.provider,j.drive_file_id,j.format,j.mime_type,j.error,j.created_at,j.updated_at,t.title,t.artist,t.album,t.artwork_url,t.duration_ms,t.source,t.source_url FROM download_jobs j LEFT JOIN tracks t ON t.id=j.track_id WHERE j.status=? ORDER BY datetime(j.created_at) DESC LIMIT ?`
    : `SELECT j.id AS job_id,j.track_id,j.kind,j.status,j.provider,j.drive_file_id,j.format,j.mime_type,j.error,j.created_at,j.updated_at,t.title,t.artist,t.album,t.artwork_url,t.duration_ms,t.source,t.source_url FROM download_jobs j LEFT JOIN tracks t ON t.id=j.track_id ORDER BY datetime(j.created_at) DESC LIMIT ?`;
  const result = status ? await env.DB.prepare(sql).bind(status, limit).all() : await env.DB.prepare(sql).bind(limit).all();
  return json({ items: result.results || [], limit });
}

async function acquisitionSummary(env, req) {
  if (!(await requireAuth(env, req))) return json({ error: "Authentication required" }, 401);
  const result = await env.DB.prepare(`SELECT status,COUNT(*) AS count FROM download_jobs GROUP BY status`).all();
  const counts = {};
  for (const row of result.results || []) counts[row.status] = Number(row.count || 0);
  return json({ counts, active: (counts.queued || 0) + (counts.dispatched || 0) + (counts.running || 0) });
}

async function withPlayerDetails(response) {
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;
  const html = await response.text();
  if (html.includes("player-details.js")) return new Response(html, response);
  const patched = html.replace(/<\/body>/i, '<script src="/player-details.js"></script></body>');
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(patched, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if ((path === "/api/v1/acquisitions" || path === "/api/v1/jobs") && req.method === "GET") return listAcquisitions(env, req);
    if (path === "/api/v1/acquisitions/summary" && req.method === "GET") return acquisitionSummary(env, req);
    return withPlayerDetails(await worker.fetch(req, env, ctx));
  },
};

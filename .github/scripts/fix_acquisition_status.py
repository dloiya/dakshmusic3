from pathlib import Path

ENTRY = Path("serverless/entry.js")
UI = Path("frontend/playlist-ui.js")

s = ENTRY.read_text()

if "async function listAcquisitions(env, req)" not in s:
    marker = "export default {"
    if marker not in s:
        raise SystemExit("entry.js export marker not found")

    helpers = '''async function listAcquisitions(env, req) {
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

'''
    s = s.replace(marker, helpers + marker, 1)

route = '    const path = url.pathname;'
insert = '''    const path = url.pathname;

    if ((path === "/api/v1/acquisitions" || path === "/api/v1/jobs") && req.method === "GET") return listAcquisitions(env, req);
    if (path === "/api/v1/acquisitions/summary" && req.method === "GET") return acquisitionSummary(env, req);'''

if 'path === "/api/v1/acquisitions"' not in s:
    if route not in s:
        raise SystemExit("entry.js route marker not found")
    s = s.replace(route, insert, 1)

ENTRY.write_text(s)

u = UI.read_text()
u = u.replace("`${API}/jobs/status`", "`${API}/acquisitions?limit=100`")
u = u.replace("const jobs = data.jobs || [];", "const jobs = Array.isArray(data) ? data : (data.items || []);")
UI.write_text(u)

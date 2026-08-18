import json
import os
import subprocess

DB = os.environ.get("D1_DATABASE", "dakshmusic3")
RESULT_FILE = "/tmp/acquisition-result.json"


def run_wrangler(sql):
    command = ["npx", "wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql]
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    payload = json.loads(result.stdout)
    if isinstance(payload, list):
        if len(payload) == 1 and isinstance(payload[0], dict):
            rows = payload[0].get("results") or payload[0].get("result")
            if isinstance(rows, list):
                return rows
            if isinstance(rows, dict):
                return rows.get("results") or rows.get("result") or []
        return payload
    if isinstance(payload, dict):
        rows = payload.get("results") or payload.get("result")
        if isinstance(rows, list):
            return rows
        if isinstance(rows, dict):
            return rows.get("results") or rows.get("result") or []
    return []


def sql(value):
    return "'" + str(value or "").replace("'", "''") + "'"


def set_failed(job_id, error):
    run_wrangler(
        "UPDATE acquisition_jobs SET status='failed',last_error=" + sql(error) + ",updated_at=CURRENT_TIMESTAMP WHERE id=" + sql(job_id)
    )


rows = run_wrangler(
    "SELECT j.id AS job_id,j.track_id,t.title,t.artist,t.album_name,t.source,t.source_id,t.source_url "
    "FROM acquisition_jobs j JOIN tracks t ON t.id=j.track_id "
    "WHERE j.status='queued' ORDER BY j.created_at,j.id LIMIT 1"
)

if not rows:
    print("No queued acquisition jobs. Nothing to do.")
    raise SystemExit(0)

job = rows[0]
if not isinstance(job, dict) or "job_id" not in job or "track_id" not in job:
    print(f"Unexpected D1 row format: {job!r}")
    raise SystemExit(2)

job_id = str(job["job_id"])
track_id = str(job["track_id"])

claimed = run_wrangler(
    "UPDATE acquisition_jobs SET status='running',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP "
    "WHERE id=" + sql(job_id) + " AND status='queued' RETURNING id"
)
if not claimed:
    print(f"Job {job_id} was already claimed; exiting.")
    raise SystemExit(0)

run_wrangler("UPDATE tracks SET storage_status='queued',updated_at=CURRENT_TIMESTAMP WHERE id=" + sql(track_id) + " AND storage_status!='available'")

env = os.environ.copy()
env.update({
    "JOB_ID": job_id,
    "TRACK_ID": track_id,
    "TITLE": str(job.get("title") or ""),
    "ARTIST": str(job.get("artist") or ""),
    "ALBUM": str(job.get("album_name") or ""),
    "SOURCE": str(job.get("source") or ""),
    "SOURCE_ID": str(job.get("source_id") or ""),
    "SOURCE_URL": str(job.get("source_url") or ""),
    "RESULT_FILE": RESULT_FILE,
})

print(f"Acquiring {job_id}: {job.get('title')} / {job.get('artist')}")
try:
    result = subprocess.run(["python", "workers/acquire/acquire.py"], env=env)
except Exception as exc:
    set_failed(job_id, str(exc))
    raise

try:
    outcome = json.loads(open(RESULT_FILE, encoding="utf-8").read())
except Exception as exc:
    outcome = {"status": "failed", "error": f"Missing/invalid acquisition result: {exc}"}

if result.returncode != 0 or outcome.get("status") != "complete":
    error = str(outcome.get("error") or f"acquire.py exited with code {result.returncode}")
    set_failed(job_id, error)
    raise SystemExit(result.returncode or 1)

storage_key = outcome.get("storage_key")
duration = outcome.get("duration_ms")
size_bytes = outcome.get("size_bytes")

run_wrangler(
    "UPDATE acquisition_jobs SET status='complete',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=" + sql(job_id)
)
run_wrangler(
    "UPDATE tracks SET storage_key=" + sql(storage_key) + ",duration_ms=COALESCE(" + sql(duration) + ",duration_ms),storage_status='available',updated_at=CURRENT_TIMESTAMP WHERE id=" + sql(track_id)
)
run_wrangler(
    "INSERT OR REPLACE INTO cache_objects(track_id,scope,scope_id,storage_key,status,size_bytes,last_accessed_at) VALUES (" + sql(track_id) + ",'server',NULL," + sql(storage_key) + ",'available'," + sql(size_bytes) + ",CURRENT_TIMESTAMP)"
)
print(f"Completed {job_id}: {storage_key}")

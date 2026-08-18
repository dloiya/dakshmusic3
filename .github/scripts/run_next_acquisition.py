import json
import os
import subprocess

DB = os.environ.get("D1_DATABASE", "dakshmusic3")


def run_wrangler(sql):
    command = [
        "npx", "wrangler", "d1", "execute", DB,
        "--remote", "--json", "--command", sql,
    ]
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    payload = json.loads(result.stdout)

    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = payload.get("results") or payload.get("result") or []
        if isinstance(rows, dict):
            rows = rows.get("results") or rows.get("result") or []
    else:
        rows = []

    return rows if isinstance(rows, list) else []


def sql(value):
    return "'" + str(value or "").replace("'", "''") + "'"


rows = run_wrangler(
    "SELECT j.id AS job_id,j.track_id,t.title,t.artist,t.album_name,"
    "t.source,t.source_id,t.source_url "
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
    "UPDATE acquisition_jobs SET status='running',attempts=attempts+1,"
    "updated_at=CURRENT_TIMESTAMP WHERE id=" + sql(job_id) + " AND status='queued' RETURNING id"
)

if not claimed:
    print(f"Job {job_id} was already claimed; exiting.")
    raise SystemExit(0)

run_wrangler(
    "UPDATE tracks SET storage_status='queued',updated_at=CURRENT_TIMESTAMP WHERE id="
    + sql(track_id) + " AND storage_status!='available'"
)

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
})

print(f"Acquiring {job_id}: {job.get('title')} / {job.get('artist')}")

result = subprocess.run(
    ["python", "workers/acquire/acquire.py"],
    env=env,
)

if result.returncode != 0:
    raise SystemExit(result.returncode)

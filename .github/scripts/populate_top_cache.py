import json
import os
import subprocess
import tempfile
import urllib.request
import uuid

LIMIT = max(1, min(int(os.environ.get("LIMIT", "100")), 1000))
DB = os.environ.get("D1_DATABASE", "dakshmusic3")
REPO = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GH_TOKEN"]


def run_wranger(sql):
    command = [
        "npx", "wrangler", "d1", "execute", DB,
        "--remote", "--json", "--command", sql,
    ]
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    return json.loads(result.stdout)


def sql(value):
    return "'" + str(value).replace("'", "''") + "'"


query = f"""
SELECT t.id,t.title,t.artist,t.album_name,t.source,t.source_id,t.source_url
FROM tracks t
WHERE t.cache_requested=1
  AND t.storage_status!='available'
  AND NOT EXISTS (
    SELECT 1 FROM acquisition_jobs j
    WHERE j.track_id=t.id
      AND j.status IN ('queued','dispatched','running')
  )
ORDER BY t.play_count DESC,t.id
LIMIT {LIMIT}
""".strip()

payload = run_wranger(query)
rows = payload.get("results") or payload.get("result") or []
if isinstance(rows, dict):
    rows = rows.get("results", [])

if not rows:
    print("No pending Top Cache tracks.")
    raise SystemExit(0)

# Create all acquisition jobs in one D1 operation before dispatching the
# individual GitHub acquisition workflows. This keeps the Worker completely
# out of the expensive loop and makes retries idempotent.
sql_parts = []
for track in rows:
    job_id = str(uuid.uuid4())
    track["job_id"] = job_id
    sql_parts.append(
        "UPDATE tracks SET storage_status='queued',updated_at=CURRENT_TIMESTAMP "
        f"WHERE id={int(track['id'])} AND storage_status!='available';"
    )
    sql_parts.append(
        "INSERT INTO acquisition_jobs(id,track_id,status,worker,attempts) "
        f"SELECT {sql(job_id)},{int(track['id'])},'queued','github-actions',0 "
        "WHERE NOT EXISTS (SELECT 1 FROM acquisition_jobs "
        f"WHERE track_id={int(track['id'])} AND status IN ('queued','dispatched','running'));"
    )

with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as handle:
    handle.write("\n".join(sql_parts))
    sql_file = handle.name

try:
    subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB, "--remote", "--file", sql_file],
        check=True,
    )
finally:
    try:
        os.unlink(sql_file)
    except OSError:
        pass

# Dispatch the existing acquisition workflow from the GitHub runner.
# Network wait time happens outside the Cloudflare Worker request.
api = f"https://api.github.com/repos/{REPO}/actions/workflows/acquire-audio.yml/dispatches"
for track in rows:
    body = {
        "ref": os.environ.get("GITHUB_REF_NAME", "main"),
        "inputs": {
            "track_id": str(track["id"]),
            "job_id": track["job_id"],
            "title": str(track.get("title") or ""),
            "artist": str(track.get("artist") or ""),
            "album": str(track.get("album_name") or ""),
            "source": str(track.get("source") or ""),
            "source_id": str(track.get("source_id") or ""),
            "source_url": str(track.get("source_url") or ""),
        },
    }
    request = urllib.request.Request(
        api,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status not in (201, 204):
            raise RuntimeError(f"acquisition dispatch failed: HTTP {response.status}")

print(f"Queued {len(rows)} Top Cache tracks and dispatched acquisition workflows.")

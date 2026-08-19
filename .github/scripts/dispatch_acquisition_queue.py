import json
import os
import subprocess
import urllib.request

LIMIT = max(1, min(int(os.environ.get("QUEUE_LIMIT", "10")), 50))
DB = os.environ.get("D1_DATABASE", "dakshmusic3")
REPO = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GH_TOKEN"]
REF = os.environ.get("GITHUB_REF_NAME", "main")


def run_wranger(sql):
    command = ["npx", "wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql]
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    payload = json.loads(result.stdout)
    rows = payload.get("results") or payload.get("result") or []
    if isinstance(rows, dict):
        rows = rows.get("results", [])
    return rows


def sql(value):
    return "'" + str(value or "").replace("'", "''") + "'"


query = f"""
SELECT j.id AS job_id,j.track_id,t.title,t.artist,t.album_name,t.isrc,
       t.source,t.source_id,t.source_url
FROM acquisition_jobs j
JOIN tracks t ON t.id=j.track_id
WHERE j.status='queued'
ORDER BY j.created_at,j.id
LIMIT {LIMIT}
""".strip()

rows = run_wranger(query)
if not rows:
    print("No queued acquisition jobs.")
    raise SystemExit(0)

api = f"https://api.github.com/repos/{REPO}/actions/workflows/acquire-audio.yml/dispatches"

for track in rows:
    body = {
        "ref": REF,
        "inputs": {
            "track_id": str(track["track_id"]),
            "job_id": str(track["job_id"]),
            "title": str(track.get("title") or ""),
            "artist": str(track.get("artist") or ""),
            "album": str(track.get("album_name") or ""),
            "isrc": str(track.get("isrc") or ""),
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
            "User-Agent": "dakshmusic3-acquisition-queue",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status not in (201, 204):
                raise RuntimeError(f"dispatch failed: HTTP {response.status}")
    except Exception as exc:
        print(f"Dispatch failed for job {track['job_id']}: {exc}")
        continue

    run_wranger(
        "UPDATE acquisition_jobs SET status='dispatched',attempts=attempts+1,"
        "updated_at=CURRENT_TIMESTAMP WHERE id=" + sql(track["job_id"]) + ";"
    )
    print(f"Dispatched {track['job_id']} — {track.get('title')} / {track.get('artist')}")

print(f"Processed {len(rows)} queued acquisition jobs.")

import mimetypes
import os
import sys
import urllib.error
import urllib.request


def require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Required environment variable is missing: {name}")
    return value


def main(path):
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Audio file does not exist: {path}")

    worker_base_url = require_env("WORKER_BASE_URL").rstrip("/")
    job_id = require_env("JOB_ID")
    callback_secret = require_env("CALLBACK_SECRET")
    provider = os.environ.get("PROVIDER", "spotiflac")

    ext = os.path.splitext(path)[1].lstrip(".").lower() or "flac"
    content_type = mimetypes.guess_type(path)[0] or (
        "audio/mpeg" if ext == "mp3" else "audio/flac"
    )

    upload_url = f"{worker_base_url}/api/v1/jobs/{job_id}/audio?provider={provider}&format={ext}"

    with open(path, "rb") as fh:
        file_data = fh.read()

    print(f"Uploading {os.path.basename(path)} ({len(file_data)} bytes) to R2 via the Worker...")

    req = urllib.request.Request(
        upload_url,
        data=file_data,
        headers={
            "Content-Type": content_type,
            "X-Callback-Secret": callback_secret,
            "User-Agent": "Mozilla/5.0 (compatible; DakshMusicServer/1.0; +https://github.com/dloiya/dakshmusic3)",
        },
        method="PUT",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            body = response.read().decode("utf-8", errors="replace")
            print(f"Upload response: {body}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"Upload failed: HTTP {e.code}", file=sys.stderr)
        print(body, file=sys.stderr)
        raise RuntimeError(f"R2 upload failed with HTTP {e.code}") from e

    print("Upload completed successfully.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <audio-file>", file=sys.stderr)
        sys.exit(2)

    try:
        main(sys.argv[1])
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

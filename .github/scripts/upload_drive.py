import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


TOKEN_URL = "https://oauth2.googleapis.com/token"
DRIVE_API = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"


def post_form(url, values):
    data = urllib.parse.urlencode(values).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)

    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")

        print(f"Google OAuth error: HTTP {e.code}", file=sys.stderr)

        try:
            error_data = json.loads(body)
            print(
                json.dumps(error_data, indent=2),
                file=sys.stderr,
            )
        except json.JSONDecodeError:
            print(body, file=sys.stderr)

        raise RuntimeError(
            f"Google OAuth token request failed with HTTP {e.code}"
        ) from e


def api(url, token, method="GET", body=None, content_type=None):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }

    if content_type:
        headers["Content-Type"] = content_type

    req = urllib.request.Request(
        url,
        data=body,
        headers=headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return json.load(response)

    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")

        print(
            f"Google Drive API error: HTTP {e.code}",
            file=sys.stderr,
        )

        try:
            error_data = json.loads(body_text)
            print(
                json.dumps(error_data, indent=2),
                file=sys.stderr,
            )
        except json.JSONDecodeError:
            print(body_text, file=sys.stderr)

        raise RuntimeError(
            f"Google Drive API request failed with HTTP {e.code}"
        ) from e


def require_env(name):
    value = os.environ.get(name)

    if not value:
        raise RuntimeError(
            f"Required environment variable is missing: {name}"
        )

    return value


def get_access_token():
    client_id = require_env("GOOGLE_CLIENT_ID")
    client_secret = require_env("GOOGLE_CLIENT_SECRET")
    refresh_token = require_env("GOOGLE_REFRESH_TOKEN")

    token_data = post_form(
        TOKEN_URL,
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
    )

    access_token = token_data.get("access_token")

    if not access_token:
        raise RuntimeError(
            "Google OAuth response did not contain an access_token"
        )

    return access_token


def find_or_create_root_folder(token):
    root_name = os.environ.get(
        "GOOGLE_DRIVE_ROOT_FOLDER",
        "MusicLibrary",
    )

    # Escape single quotes for the Drive query.
    escaped_name = root_name.replace("\\", "\\\\").replace("'", "\\'")

    query = (
        "mimeType='application/vnd.google-apps.folder' "
        f"and name='{escaped_name}' "
        "and trashed=false"
    )

    params = urllib.parse.urlencode(
        {
            "q": query,
            "fields": "files(id,name)",
            "pageSize": "10",
        }
    )

    result = api(
        f"{DRIVE_API}/files?{params}",
        token,
    )

    files = result.get("files", [])

    if files:
        root = files[0]["id"]
        print(
            f"Using existing Google Drive folder: "
            f"{root_name} ({root})"
        )
        return root

    print(
        f"Creating Google Drive folder: {root_name}"
    )

    body = json.dumps(
        {
            "name": root_name,
            "mimeType": "application/vnd.google-apps.folder",
        }
    ).encode("utf-8")

    created = api(
        f"{DRIVE_API}/files",
        token,
        method="POST",
        body=body,
        content_type="application/json",
    )

    root = created["id"]

    print(f"Created Google Drive folder: {root}")

    return root


def upload_file(token, path, root):
    filename = os.path.basename(path)

    mime_type = (
        mimetypes.guess_type(filename)[0]
        or "audio/flac"
    )

    with open(path, "rb") as fh:
        file_data = fh.read()

    metadata = json.dumps(
        {
            "name": filename,
            "parents": [root],
        }
    ).encode("utf-8")

    boundary = "----musicserverboundary"

    multipart = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n"
        "\r\n"
    ).encode("utf-8")

    multipart += metadata

    multipart += (
        f"\r\n--{boundary}\r\n"
        f"Content-Type: {mime_type}\r\n"
        "\r\n"
    ).encode("utf-8")

    multipart += file_data

    multipart += (
        f"\r\n--{boundary}--\r\n"
    ).encode("utf-8")

    params = urllib.parse.urlencode(
        {
            "uploadType": "multipart",
            "fields": "id,name,mimeType,size",
        }
    )

    upload_url = (
        f"{DRIVE_UPLOAD}?{params}"
    )

    print(
        f"Uploading {filename} "
        f"({len(file_data)} bytes) to Google Drive..."
    )

    uploaded = api(
        upload_url,
        token,
        method="POST",
        body=multipart,
        content_type=(
            f"multipart/related; boundary={boundary}"
        ),
    )

    print(
        f"Uploaded: {uploaded.get('name')} "
        f"({uploaded.get('id')})"
    )

    return uploaded


def send_callback(uploaded):
    callback_url = require_env("CALLBACK_URL")
    callback_secret = require_env("CALLBACK_SECRET")
    job_id = require_env("JOB_ID")
    provider = os.environ.get(
        "PROVIDER",
        "spotiflac",
    )

    payload = {
        "job_id": job_id,
        "status": "complete",
        "provider": provider,
        "drive_file_id": uploaded["id"],
        "format": "flac",
        "mime_type": uploaded.get(
            "mimeType",
            "audio/flac",
        ),
    }

    request = urllib.request.Request(
        callback_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Callback-Secret": callback_secret,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(
            request,
            timeout=60,
        ) as response:
            response_body = response.read().decode(
                "utf-8",
                errors="replace",
            )

            print(
                f"Callback response: {response_body}"
            )

    except urllib.error.HTTPError as e:
        body = e.read().decode(
            "utf-8",
            errors="replace",
        )

        print(
            f"Callback failed: HTTP {e.code}",
            file=sys.stderr,
        )
        print(body, file=sys.stderr)

        raise


def main(path):
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"Audio file does not exist: {path}"
        )

    print("Getting Google Drive access token...")

    token = get_access_token()

    print("Google OAuth authentication successful.")

    root = find_or_create_root_folder(token)

    uploaded = upload_file(
        token,
        path,
        root,
    )

    send_callback(uploaded)

    print("Google Drive upload completed successfully.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(
            f"Usage: {sys.argv[0]} <audio-file>",
            file=sys.stderr,
        )
        sys.exit(2)

    try:
        main(sys.argv[1])
    except Exception as exc:
        print(
            f"ERROR: {exc}",
            file=sys.stderr,
        )
        sys.exit(1)

import json
import mimetypes
import os
import sys
import urllib.parse
import urllib.request

def post_form(url, values):
    data = urllib.parse.urlencode(values).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)

def api(url, token, method="GET", body=None, content_type=None):
    headers = {"Authorization": f"Bearer {token}"}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req) as r:
        return json.load(r)

def main(path):
    token_data = post_form("https://oauth2.googleapis.com/token", {
        "client_id": os.environ["GOOGLE_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    })
    token = token_data["access_token"]

    root_name = os.environ.get("GOOGLE_DRIVE_ROOT_FOLDER", "MusicLibrary")
    q = "mimeType='application/vnd.google-apps.folder' and name='" + root_name.replace("'", "\\'") + "' and trashed=false"
    result = api("https://www.googleapis.com/drive/v3/files?q=" + urllib.parse.quote(q) + "&fields=files(id,name)", token)
    files = result.get("files", [])
    if files:
        root = files[0]["id"]
    else:
        body = json.dumps({"name": root_name, "mimeType": "application/vnd.google-apps.folder"}).encode()
        created = api("https://www.googleapis.com/drive/v3/files", token, "POST", body, "application/json")
        root = created["id"]

    filename = os.path.basename(path)
    metadata = json.dumps({"name": filename, "parents": [root]}).encode()

    boundary = "----musicserverboundary"
    mime = mimetypes.guess_type(filename)[0] or "audio/flac"
    with open(path, "rb") as fh:
        data = fh.read()

    multipart = (
        f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode()
        + metadata
        + f"\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n".encode()
        + data
        + f"\r\n--{boundary}--\r\n".encode()
    )

    upload_url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size"
    uploaded = api(upload_url, token, "POST", multipart, f"multipart/related; boundary={boundary}")

    callback = os.environ["CALLBACK_URL"]
    req = urllib.request.Request(
        callback,
        data=json.dumps({
            "job_id": os.environ["JOB_ID"],
            "status": "complete",
            "provider": os.environ["PROVIDER"],
            "drive_file_id": uploaded["id"],
            "format": "flac",
            "mime_type": uploaded.get("mimeType", "audio/flac"),
        }).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Callback-Secret": os.environ["CALLBACK_SECRET"],
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        print(r.read().decode())

if __name__ == "__main__":
    main(sys.argv[1])

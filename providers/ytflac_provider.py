import base64, os, shutil, subprocess, tempfile
from pathlib import Path


def main():
    title = os.environ["AUDIO_TITLE"]
    artist = os.environ["AUDIO_ARTIST"]
    output = Path(os.environ["AUDIO_OUTPUT"]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        "yt-dlp", f"ytsearch1:{title} {artist}", "--no-playlist", "-x",
        "-f", "bestaudio/best",
        "--audio-format", "flac", "--audio-quality", "0", "--embed-metadata",
        "--embed-thumbnail", "--convert-thumbnails", "jpg", "--js-runtimes", "deno",
        "--remote-components", "ejs:github",
        "-o", str(output.with_suffix(".%(ext)s")),
        "--no-warnings", "--print", "after_move:filepath",
    ]

    # Optional: if YTDLP_COOKIES_B64 is set (base64-encoded cookies.txt,
    # exported from a real logged-in browser session), use it. This is the
    # most reliable way to avoid "Sign in to confirm you're not a bot", but
    # it's opt-in since it ties the job to a real account.
    cookies_b64 = os.environ.get("YTDLP_COOKIES_B64")
    cookies_path = None
    if cookies_b64:
        cookies_path = Path(tempfile.mkstemp(suffix=".txt")[1])
        cookies_path.write_bytes(base64.b64decode(cookies_b64))
        cmd += ["--cookies", str(cookies_path)]

    try:
        p = subprocess.run(cmd, text=True, capture_output=True, timeout=12 * 60)
    finally:
        if cookies_path:
            cookies_path.unlink(missing_ok=True)

    print(p.stdout)
    print(p.stderr, file=__import__("sys").stderr)
    if p.returncode:
        raise SystemExit(p.returncode)

    if not output.exists():
        fs = list(output.parent.glob(output.stem + ".flac"))
        if fs:
            shutil.move(fs[0], output)
    if not output.exists():
        raise RuntimeError("YtFLAC/yt-dlp produced no FLAC")


if __name__ == "__main__":
    main()

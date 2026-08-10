import glob, os, shutil, subprocess, sys
from pathlib import Path
from resolve_apple import apple_music_url_from_search


def main():
    source = os.environ.get("AUDIO_SOURCE_URL", "")
    title = os.environ["AUDIO_TITLE"]
    artist = os.environ["AUDIO_ARTIST"]
    album = os.environ.get("AUDIO_ALBUM", "")
    output = Path(os.environ["AUDIO_OUTPUT"]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    # spotiflac needs a Spotify/Tidal/Apple Music/SoundCloud/YouTube/Pandora
    # URL as its input identifier (it explicitly rejects Deezer URLs, which
    # is what our own search results are). We resolve through Apple's free,
    # unauthenticated iTunes Search API rather than Spotify, since Spotify
    # now requires the app-owning account to have Premium just to register
    # a developer app -- and even the unofficial/anonymous lookup path gets
    # blocked from GitHub Actions' IP ranges.
    if "music.apple.com" in source:
        resolved = source
    else:
        resolved = apple_music_url_from_search(title, artist, album)

    outdir = output.parent / "_spotiflac"
    outdir.mkdir(parents=True, exist_ok=True)

    exe = shutil.which("spotiflac") or sys.executable
    cmd = [
        exe, resolved, str(outdir),
        "--service", "deezer", "tidal", "qobuz", "amazon",
        "--quality", "LOSSLESS", "--retries", "2", "--timeout", "180",
        "--no-lyrics", "--no-extensions-fallback",
    ]
    if not shutil.which("spotiflac"):
        cmd.insert(1, "-m")
        cmd.insert(2, "SpotiFLAC")

    p = subprocess.run(cmd, text=True, capture_output=True, timeout=15 * 60)
    print(p.stdout)
    print(p.stderr, file=sys.stderr)
    if p.returncode:
        raise SystemExit(p.returncode)

    files = [Path(x) for x in glob.glob(str(outdir / "**" / "*.flac"), recursive=True)]
    if not files:
        raise RuntimeError("SpotiFLAC produced no FLAC")
    shutil.copy2(max(files, key=lambda x: x.stat().st_mtime), output)


if __name__ == "__main__":
    main()

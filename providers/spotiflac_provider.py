import asyncio
import glob
import os
import sys
from pathlib import Path

from resolve_apple import resolve_apple_music_url


def _patch_redirects():
    """
    SpotiFLAC's shared httpx.AsyncClient is constructed without
    follow_redirects=True (httpx defaults to False). Several of its
    providers -- including Apple Music's auth-token bootstrap, which we
    depend on -- hit URLs that redirect (e.g. music.apple.com/us/browse
    returning a 301), and SpotiFLAC's own error handling treats any
    non-2xx/3xx response as a hard NetworkError instead of following the
    redirect. This is a bug in the installed package (present in both the
    pinned 1.5.2 and the latest 1.6.7 release as of this writing), not
    something we can fix by editing our own files, so we patch it at
    runtime instead of forking/vendoring the whole dependency.
    """
    import threading
    import httpx
    from SpotiFLAC.core.http import NetworkManager

    async def _patched(cls):
        loop = asyncio.get_running_loop()
        loop_id = id(loop)
        client = cls._async_clients.get(loop_id)
        if client is not None:
            return client
        with cls._async_clients_lock:
            client = cls._async_clients.get(loop_id)
            if client is None:
                limits = httpx.Limits(max_keepalive_connections=30, max_connections=100)
                client = httpx.AsyncClient(limits=limits, timeout=30.0, follow_redirects=True)
                cls._async_clients[loop_id] = client
        return client

    NetworkManager.get_async_client_safe = classmethod(_patched)
    NetworkManager._async_clients_lock = threading.Lock()


async def _download(resolved_url, outdir):
    from SpotiFLAC.client import AsyncSpotiFLAC

    async with AsyncSpotiFLAC(
        output_dir=str(outdir),
        services=["deezer", "tidal", "qobuz", "amazon"],
        quality="LOSSLESS",
        track_max_retries=2,
        timeout_s=180,
        embed_lyrics=False,
        use_extensions_fallback=False,
    ) as client:
        await client.download_track(resolved_url)


def main():
    source = os.environ.get("AUDIO_SOURCE_URL", "")
    title = os.environ["AUDIO_TITLE"]
    artist = os.environ["AUDIO_ARTIST"]
    album = os.environ.get("AUDIO_ALBUM", "")
    output = Path(os.environ["AUDIO_OUTPUT"]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    if "music.apple.com" in source:
        resolved = source
    else:
        resolved = resolve_apple_music_url(title, artist, album, source_url=source)

    outdir = output.parent / "_spotiflac"
    outdir.mkdir(parents=True, exist_ok=True)

    _patch_redirects()
    asyncio.run(_download(resolved, outdir))

    files = [Path(x) for x in glob.glob(str(outdir / "**" / "*.flac"), recursive=True)]
    if not files:
        raise RuntimeError("SpotiFLAC produced no FLAC")
    import shutil
    shutil.copy2(max(files, key=lambda x: x.stat().st_mtime), output)


if __name__ == "__main__":
    main()

import os,shutil,subprocess
from pathlib import Path
def main():
    title=os.environ["AUDIO_TITLE"]; artist=os.environ["AUDIO_ARTIST"]
    output=Path(os.environ["AUDIO_OUTPUT"]).resolve(); output.parent.mkdir(parents=True,exist_ok=True)
    cmd=["yt-dlp",f"ytsearch1:{title} {artist}","--no-playlist","-x",
         "--audio-format","flac","--audio-quality","0","--embed-metadata",
         "--embed-thumbnail","--convert-thumbnails","jpg","--js-runtimes","deno",
         "--remote-components","ejs:github","-o",str(output.with_suffix(".%(ext)s")),
         "--no-warnings","--print","after_move:filepath"]
    p=subprocess.run(cmd,text=True,capture_output=True,timeout=12*60)
    print(p.stdout); print(p.stderr,file=__import__("sys").stderr)
    if p.returncode: raise SystemExit(p.returncode)
    if not output.exists():
        fs=list(output.parent.glob(output.stem+".flac"))
        if fs: shutil.move(fs[0],output)
    if not output.exists(): raise RuntimeError("YtFLAC/yt-dlp produced no FLAC")
if __name__=="__main__": main()

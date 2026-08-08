import glob,os,shutil,subprocess,sys
from pathlib import Path
from resolve_spotify import spotify_url_from_search
def main():
    source=os.environ.get("AUDIO_SOURCE_URL","")
    title=os.environ["AUDIO_TITLE"]; artist=os.environ["AUDIO_ARTIST"]
    output=Path(os.environ["AUDIO_OUTPUT"]).resolve(); output.parent.mkdir(parents=True,exist_ok=True)
    spotify=source if "open.spotify.com/" in source else spotify_url_from_search(title,artist,"track")
    outdir=output.parent/"_spotiflac"; outdir.mkdir(parents=True,exist_ok=True)
    exe=shutil.which("spotiflac") or sys.executable
    cmd=[exe,spotify,str(outdir),"--service","deezer","tidal","qobuz","amazon",
         "--quality","LOSSLESS","--retries","2","--timeout","180","--no-lyrics",
         "--no-extensions-fallback"]
    if not shutil.which("spotiflac"): cmd.insert(1,"-m"); cmd.insert(2,"SpotiFLAC")
    p=subprocess.run(cmd,text=True,capture_output=True,timeout=15*60)
    print(p.stdout); print(p.stderr,file=sys.stderr)
    if p.returncode: raise SystemExit(p.returncode)
    files=[Path(x) for x in glob.glob(str(outdir/"**"/"*.flac"),recursive=True)]
    if not files: raise RuntimeError("SpotiFLAC produced no FLAC")
    shutil.copy2(max(files,key=lambda x:x.stat().st_mtime),output)
if __name__=="__main__": main()

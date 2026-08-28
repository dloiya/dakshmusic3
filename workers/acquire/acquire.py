from __future__ import annotations

import base64, json, os, re, shutil, subprocess, tempfile
from pathlib import Path
from urllib.parse import quote
import requests

JOB_ID=os.environ["JOB_ID"]; TRACK_ID=os.environ["TRACK_ID"]
TITLE=os.environ.get("TITLE",""); ARTIST=os.environ.get("ARTIST","")
SOURCE=os.environ.get("SOURCE",""); SOURCE_ID=os.environ.get("SOURCE_ID",""); SOURCE_URL=os.environ.get("SOURCE_URL",""); ISRC=os.environ.get("ISRC","")
R2_ENDPOINT=os.environ["R2_ENDPOINT"]; R2_BUCKET=os.environ.get("R2_BUCKET","dakshmusic3-audio"); R2_ACCESS_KEY=os.environ["R2_ACCESS_KEY"]; R2_SECRET=os.environ["R2_SECRET_KEY"]
RESULT_FILE=Path(os.environ.get("RESULT_FILE","/tmp/acquisition-result.json"))

MDL_HOSTS=("open.spotify.com","music.apple.com","music.amazon.","music.youtube.com","youtube.com","youtu.be","soundcloud.com","bandcamp.com","deezer.com","qobuz.com","tidal.com")

def write_result(status, **extra): RESULT_FILE.write_text(json.dumps({"job_id":JOB_ID,"track_id":TRACK_ID,"status":status,**extra}),encoding="utf-8")

def spotify_from_isrc():
    if not ISRC:return None
    try:
        d=requests.get(f"https://isrctools.com/api/lookup/{ISRC}",timeout=30).json()
        for t in d.get("tracks") or []:
            u=str(t.get("url") or "")
            m=re.search(r"https?://open\.spotify\.com/track/[A-Za-z0-9]+",u)
            if m:return m.group(0)
    except Exception as e: print("ISRC lookup failed:",e)
    return None

def mdl_url():
    u=SOURCE_URL
    if u.startswith(("http://","https://")) and any(h in u.casefold() for h in MDL_HOSTS):
        print(f"MusicDL input: source URL {u}"); return u
    if SOURCE=="deezer" and SOURCE_ID:return f"https://www.deezer.com/track/{quote(SOURCE_ID,safe='')}"
    return spotify_from_isrc()

def find_flac(root):
    files=[p for p in root.rglob("*.flac") if p.is_file() and p.stat().st_size>=1024]
    return max(files,key=lambda p:p.stat().st_mtime) if files else None

def run_mdl(output):
    u=mdl_url()
    if not u: raise RuntimeError("No supported MusicDL URL")
    outdir=output.parent/"mdl-output"; outdir.mkdir(exist_ok=True)
    # Use the official zero-install invocation directly.
    cmd=["npx","--yes","@mdlx/cli",u,"--format","flac","--output",str(outdir)]
    print("Running MusicDL via npx:"," ".join(cmd[:5]),"...")
    r=subprocess.run(cmd,cwd=str(outdir),text=True,capture_output=True,timeout=12*60)
    print("MusicDL stdout tail:",r.stdout[-2000:])
    if r.returncode: raise RuntimeError((r.stderr[-4000:] or r.stdout[-4000:] or "MusicDL failed").replace("\n"," "))
    source=find_flac(outdir) or find_flac(output.parent)
    if not source: raise RuntimeError(f"MusicDL exited successfully but produced no FLAC. stderr={r.stderr[-2000:]!r}")
    if source.resolve()!=output.resolve(): shutil.copy2(source,output)

def run_ytdlp(output):
    target=f"ytsearch5:{ISRC} {TITLE} {ARTIST}" if ISRC else f"ytsearch5:{TITLE} {ARTIST}"
    base=["yt-dlp",target,"--no-playlist","-x","--audio-format","flac","--audio-quality","0","--embed-metadata","--js-runtimes","deno","--remote-components","ejs:github","-o",str(output.with_suffix(".%(ext)s")),"--no-warnings"]
    cookie=None
    if os.environ.get("YTDLP_COOKIES_B64"):
        fd,name=tempfile.mkstemp(suffix=".txt"); os.close(fd); cookie=Path(name); cookie.write_bytes(base64.b64decode(os.environ["YTDLP_COOKIES_B64"])); base += ["--cookies",str(cookie)]
    errors=[]
    try:
        for selector in (None,"bestaudio","best"):
            cmd=list(base)
            if selector: cmd += ["-f",selector]
            print("Running yt-dlp fallback:",selector or "auto")
            r=subprocess.run(cmd,text=True,capture_output=True,timeout=12*60)
            if r.returncode==0: break
            errors.append((r.stderr[-1500:] or r.stdout[-1500:] or "yt-dlp failed").replace("\n"," "))
        else: raise RuntimeError(" | ".join(errors))
    finally:
        if cookie: cookie.unlink(missing_ok=True)
    if not output.exists():
        source=find_flac(output.parent)
        if source and source.resolve()!=output.resolve(): shutil.move(source,output)
    if not output.exists(): raise RuntimeError("yt-dlp succeeded but produced no FLAC")

def acquire(output):
    try:
        run_mdl(output); print("Acquisition succeeded with MusicDL"); return "mdl"
    except Exception as e:
        print("MusicDL failed:",e); print("Falling back to yt-dlp")
        run_ytdlp(output); return "yt-dlp"

def duration_ms(path):
    try:return int(float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",str(path)],text=True,capture_output=True,check=True).stdout.strip())*1000)
    except Exception:return None

def main():
    with tempfile.TemporaryDirectory() as tmp:
        output=Path(tmp)/"audio.flac"
        try:
            provider=acquire(output)
            if not output.exists() or output.stat().st_size<1024: raise RuntimeError("acquired FLAC missing or too small")
            import boto3
            boto3.client("s3",endpoint_url=R2_ENDPOINT,aws_access_key_id=R2_ACCESS_KEY,aws_secret_access_key=R2_SECRET,region_name="auto").upload_file(str(output),R2_BUCKET,f"audio/tracks/{TRACK_ID}.flac",ExtraArgs={"ContentType":"audio/flac"})
            write_result("complete",storage_key=f"audio/tracks/{TRACK_ID}.flac",duration_ms=duration_ms(output),size_bytes=output.stat().st_size,provider=provider)
        except Exception as e:
            write_result("failed",error=str(e).replace("\n"," ")[-4000:]); raise
if __name__=="__main__":main()

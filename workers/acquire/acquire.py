from __future__ import annotations
import base64,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
from urllib.parse import quote
import requests
JOB_ID=os.environ["JOB_ID"];TRACK_ID=os.environ["TRACK_ID"];TITLE=os.environ.get("TITLE","");ARTIST=os.environ.get("ARTIST","");SOURCE=os.environ.get("SOURCE","");SOURCE_ID=os.environ.get("SOURCE_ID","");SOURCE_URL=os.environ.get("SOURCE_URL","");ISRC=os.environ.get("ISRC","")
R2_ENDPOINT=os.environ["R2_ENDPOINT"];R2_BUCKET=os.environ.get("R2_BUCKET","dakshmusic3-audio");R2_ACCESS_KEY=os.environ["R2_ACCESS_KEY"];R2_SECRET=os.environ["R2_SECRET_KEY"];RESULT_FILE=Path(os.environ.get("RESULT_FILE","/tmp/acquisition-result.json"))
MDL_HOSTS=("open.spotify.com","music.apple.com","music.amazon.","music.youtube.com","youtube.com","youtu.be","soundcloud.com","bandcamp.com","deezer.com","qobuz.com","tidal.com")
def write_result(status,**extra):RESULT_FILE.write_text(json.dumps({"job_id":JOB_ID,"track_id":TRACK_ID,"status":status,**extra}),encoding="utf-8")
def spotify_from_isrc():
 if not ISRC:return None
 try:
  for t in requests.get(f"https://isrctools.com/api/lookup/{ISRC}",timeout=30).json().get("tracks") or []:
   m=re.search(r"https?://open\.spotify\.com/track/[A-Za-z0-9]+",str(t.get("url") or ""))
   if m:return m.group(0)
 except Exception as e:print("ISRC lookup failed:",e)
 return None
def mdl_url():
 if SOURCE_URL.startswith(("http://","https://")) and any(h in SOURCE_URL.casefold() for h in MDL_HOSTS):print("MusicDL input: source URL",SOURCE_URL);return SOURCE_URL
 if SOURCE=="deezer" and SOURCE_ID:return f"https://www.deezer.com/track/{quote(SOURCE_ID,safe='')}"
 return spotify_from_isrc()
def find_flac(root):
 f=[p for p in root.rglob("*.flac") if p.is_file() and p.stat().st_size>=1024];return max(f,key=lambda p:p.stat().st_mtime) if f else None
def run_mdl(output):
 u=mdl_url()
 if not u:raise RuntimeError("No supported MusicDL URL")
 d=output.parent/"mdl-output";d.mkdir(exist_ok=True)
 r=subprocess.run(["npx","--yes","@mdlx/cli",u,"--format","flac","--output",str(d)],cwd=str(d),text=True,capture_output=True,timeout=720)
 log=(r.stdout+r.stderr);print("MusicDL output tail:",log[-2500:])
 if r.returncode or re.search(r"\bError:\s*\{",log,re.I):raise RuntimeError((log[-4000:] or "MusicDL failed").replace("\n"," "))
 s=find_flac(d) or find_flac(output.parent)
 if not s:raise RuntimeError("MusicDL finished without a FLAC")
 if s.resolve()!=output.resolve():shutil.copy2(s,output)
def ytdlp_candidates():
 q=f'ytsearch10:"{ISRC}" {TITLE} {ARTIST}' if ISRC else f'ytsearch10:"{TITLE}" {ARTIST}'
 r=subprocess.run(["yt-dlp","--flat-playlist","--print","%(id)s",q,"--no-warnings"],text=True,capture_output=True,timeout=120)
 return list(dict.fromkeys(x.strip() for x in r.stdout.splitlines() if x.strip()))
def run_ytdlp(output):
 ids=ytdlp_candidates();print("yt-dlp candidate count:",len(ids))
 if not ids:raise RuntimeError("yt-dlp search returned no candidates")
 cookie=None
 if os.environ.get("YTDLP_COOKIES_B64"):
  fd,n=tempfile.mkstemp(suffix=".txt");os.close(fd);cookie=Path(n);cookie.write_bytes(base64.b64decode(os.environ["YTDLP_COOKIES_B64"]))
 errors=[]
 try:
  for vid in ids:
   url=f"https://www.youtube.com/watch?v={vid}";cmd=["yt-dlp",url,"--no-playlist","-x","--audio-format","flac","--audio-quality","0","--js-runtimes","deno","--remote-components","ejs:github","-o",str(output.with_suffix(".%(ext)s")),"--no-warnings"]
   if cookie:cmd += ["--cookies",str(cookie)]
   print("Trying yt-dlp candidate:",vid)
   r=subprocess.run(cmd,text=True,capture_output=True,timeout=720)
   if r.returncode==0:
    s=find_flac(output.parent)
    if s:
     if s.resolve()!=output.resolve():shutil.move(s,output)
     return
   errors.append((r.stderr[-800:] or r.stdout[-800:] or "yt-dlp failed").replace("\n"," "))
 finally:
  if cookie:cookie.unlink(missing_ok=True)
 raise RuntimeError(" | ".join(errors[-5:]))
def acquire(output):
 try:run_mdl(output);print("Acquisition succeeded with MusicDL");return "mdl"
 except Exception as e:print("MusicDL failed:",e);print("Falling back to yt-dlp candidates");run_ytdlp(output);return "yt-dlp"
def duration_ms(p):
 try:return int(float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",str(p)],text=True,capture_output=True,check=True).stdout.strip())*1000)
 except Exception:return None
def main():
 with tempfile.TemporaryDirectory() as tmp:
  o=Path(tmp)/"audio.flac"
  try:
   provider=acquire(o)
   if not o.exists() or o.stat().st_size<1024:raise RuntimeError("acquired FLAC missing or too small")
   import boto3
   boto3.client("s3",endpoint_url=R2_ENDPOINT,aws_access_key_id=R2_ACCESS_KEY,aws_secret_access_key=R2_SECRET,region_name="auto").upload_file(str(o),R2_BUCKET,f"audio/tracks/{TRACK_ID}.flac",ExtraArgs={"ContentType":"audio/flac"})
   write_result("complete",storage_key=f"audio/tracks/{TRACK_ID}.flac",duration_ms=duration_ms(o),size_bytes=o.stat().st_size,provider=provider)
  except Exception as e:write_result("failed",error=str(e).replace("\n"," ")[-4000:]);raise
if __name__=="__main__":main()

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API = import.meta.env.VITE_QUEUE_API_URL?.replace(/\/$/, "") || "";
const api = async (path, options = {}) => {
  const res = await fetch(`${API}${path}`, { ...options, headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) } });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `API error ${res.status}`); }
  return res;
};
const jsonApi = async (path, options = {}) => (await api(path, options)).json();

function confirmMode(current, next) {
  if (current === next) return true;
  return window.confirm(`Switch to ${next === "album" ? "album" : "track"} mode?\nThe current playback session will be replaced.`);
}
function normalize(item) { return { title:item.title, artist:item.artist?.name||"Unknown artist", album_id:item.album?.id??null, album_name:item.album?.title??null, source:"deezer", source_id:String(item.id), source_url:`https://www.deezer.com/track/${item.id}`, artwork_url:item.album?.cover_xl||item.album?.cover_medium||null, duration_ms:Number(item.duration||0)*1000, metadata_json:{deezer:item} }; }

function App() {
  const [tab,setTab]=useState("Now Playing");
  const [subtab,setSubtab]=useState("params");
  const [tracks,setTracks]=useState([]), [albums,setAlbums]=useState([]), [playlist,setPlaylist]=useState([]);
  const [current,setCurrent]=useState(null), [albumTracks,setAlbumTracks]=useState([]), [albumIndex,setAlbumIndex]=useState(0);
  const [mode,setMode]=useState("track"), [message,setMessage]=useState(""), [search,setSearch]=useState([]), [q,setQ]=useState("");
  const [history,setHistory]=useState([]); const audio=useRef(null); const fileRef=useRef(null);
  const tabs=useMemo(()=>["Now Playing","Playlist","Search","Album","Queue","Settings"],[]);

  const refresh=async()=>{ try { const [t,a,p,h]=await Promise.all([jsonApi("/api/library/tracks?limit=2000"),jsonApi("/api/library/albums?limit=1000"),jsonApi("/api/playlist"),jsonApi("/api/albums/history")]); setTracks(t.tracks||[]);setAlbums(a.albums||[]);setPlaylist(p.tracks||[]);setHistory(h.albums||[]); } catch(e){setMessage(e.message);} };
  useEffect(()=>{refresh();},[]);

  const switchMode=async(next)=>{ if(!confirmMode(mode,next))return false; try{await jsonApi("/api/playback/mode",{method:"POST",body:JSON.stringify({mode})});setMode(next);setAlbumTracks([]);setAlbumIndex(0);setMessage(`Device moved to ${next} mode`);return true;}catch(e){setMessage(e.message);return false;} };
  const playTrack=async(track)=>{ if(mode!=="track" && !(await switchMode("track")))return; try{await jsonApi("/api/play/track",{method:"POST",body:JSON.stringify({track_id:track.id})});setCurrent(track);setAlbumTracks([]);setTab("Now Playing");setTimeout(()=>audio.current?.play().catch(()=>{}),0);refresh();}catch(e){setMessage(e.message);} };
  const playAlbum=async(album)=>{ if(mode!=="album" && !(await switchMode("album")))return; try{const d=await jsonApi("/api/library/albums/${album.id}");await jsonApi("/api/play/album",{method:"POST",body:JSON.stringify({album_id:album.id})});setAlbumTracks(d.tracks||[]);setAlbumIndex(0);setCurrent(d.tracks?.[0]||null);setTab("Now Playing");setMessage(`Album mode · ${album.title}`);setTimeout(()=>audio.current?.play().catch(()=>{}),0);refresh();}catch(e){setMessage(e.message);} };
  const playNext=async()=>{if(mode==="album"&&albumTracks.length){const n=(albumIndex+1)%albumTracks.length;setAlbumIndex(n);setCurrent(albumTracks[n]);setTimeout(()=>audio.current?.play().catch(()=>{}),0);}else if(playlist.length){const i=Math.max(0,playlist.findIndex(x=>x.id===current?.id));playTrack(playlist[(i+1)%playlist.length]);}};
  const addPlaylist=async(track)=>{try{await jsonApi("/api/playlist",{method:"POST",body:JSON.stringify({track_id:track.id})});await refresh();}catch(e){setMessage(e.message);}};
  const removePlaylist=async(id)=>{try{await api(`/api/playlist/${id}`,{method:"DELETE"});await refresh();}catch(e){setMessage(e.message);}};
  const doSearch=async(e)=>{e.preventDefault();if(!q.trim())return;try{const d=await jsonApi(`/api/search?q=${encodeURIComponent(q.trim())}&limit=25`);setSearch(d.data||[]);}catch(e){setMessage(e.message);}};
  const exportCsv=async()=>{const r=await api("/api/export/tracks.csv");const blob=await r.blob();const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="tracks.csv";a.click();URL.revokeObjectURL(a.href);};
  const importCsv=async(e)=>{const f=e.target.files?.[0];if(!f)return;try{const text=await f.text();const d=await jsonApi("/api/import/tracks.csv",{method:"POST",headers:{"Content-Type":"text/csv"},body:text});setMessage(`Imported ${d.imported} tracks`);await refresh();}catch(err){setMessage(err.message);}e.target.value="";};
  const deleteData=async()=>{if(!window.confirm("Delete all tracks, playlists, queues, jobs and cache records?"))return;try{await jsonApi("/api/data/delete",{method:"POST",body:JSON.stringify({confirm:"DELETE"})});setCurrent(null);setAlbumTracks([]);await refresh();setMessage("All data deleted");}catch(e){setMessage(e.message);}};
  const onEnded=()=>playNext();

  return <main className="ipod-page"><section className="ipod"><div className="screen"><div className="screen-top"><span>daksh music</span><span className="battery"><i/></span></div>
    <div className="screen-body">
      {message&&<div className="banner">{message}</div>}
      <nav className="menu-list">{tabs.map(t=><button key={t} className={`menu-row ${tab===t?"selected":""}`} onClick={()=>setTab(t)}><span>{t}</span><span className="arrow">›</span></button>)}</nav>
      {tab==="Now Playing"&&<NowPlaying current={current} mode={mode} audio={audio} onEnded={onEnded} onNext={playNext}/>} 
      {tab==="Playlist"&&<Playlist tracks={playlist} onPlay={playTrack} onRemove={removePlaylist} onAdd={addPlaylist}/>} 
      {tab==="Search"&&<Search q={q} setQ={setQ} submit={doSearch} results={search} onPlay={playTrack} onAdd={addPlaylist}/>} 
      {tab==="Album"&&<AlbumView albums={albums} history={history} onPlay={playAlbum}/>} 
      {tab==="Queue"&&<QueueView tracks={mode==="album"?albumTracks:playlist} current={current} mode={mode} onPlay={playTrack} onNext={playNext}/>} 
      {tab==="Settings"&&<Settings subtab={subtab} setSubtab={setSubtab} onExport={exportCsv} onImport={()=>fileRef.current?.click()} onDelete={deleteData} mode={mode} />}
      <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={importCsv}/>
    </div></div>
    <div className="wheel-area"><div className="wheel"><button className="menu" onClick={()=>setTab("Now Playing")}>MENU</button><button className="prev" onClick={()=>setTab("Playlist")}>‹</button><button className="next" onClick={playNext}>›</button><button className="play" onClick={()=>audio.current?.paused?audio.current?.play():audio.current?.pause()}>▶❙❙</button><button className="center" onClick={()=>setTab("Now Playing")}/></div><div className="click-hint">MODE: {mode.toUpperCase()} · SELECT</div></div>
    <div className="footer">daksh music · {mode} mode</div>
  </section></main>;
}

function NowPlaying({current,mode,audio,onEnded,onNext}){return <div className="now-playing"><div className="art">{current?.artwork_url?<img src={current.artwork_url} alt=""/>:"♪"}</div><div className="np-info"><small>{mode.toUpperCase()} MODE</small><strong>{current?.title||"Nothing playing"}</strong><small>{current?.artist||"—"}</small><small>{current?.album_name||"—"}</small><div className="toolbar"><button className="tiny-btn" onClick={()=>audio.current?.paused?audio.current?.play():audio.current?.pause()}>Play/Pause</button><button className="tiny-btn" onClick={onNext}>Next</button></div><audio ref={audio} src={current?.preview_url||current?.metadata_json?.deezer?.preview||""} controls onEnded={onEnded}/></div></div>}
function Playlist({tracks,onPlay,onRemove,onAdd}){return <><div className="toolbar"><strong>Playlist · {tracks.length}</strong></div>{!tracks.length?<div className="empty">No playlist tracks.</div>:tracks.map(t=><div className="track-line" key={t.playlist_entry_id}><div className="track-copy" onClick={()=>onPlay(t)}><strong>{t.title}</strong><small>{t.artist} · {t.album_name||"Unknown album"}</small></div><button className="tiny-btn" onClick={()=>onPlay(t)}>▶</button><button className="tiny-btn" onClick={()=>onRemove(t.playlist_entry_id)}>×</button></div>)}</>}
function Search({q,setQ,submit,results,onPlay,onAdd}){return <><form className="toolbar" onSubmit={submit}><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Song, artist, album…"/><button className="tiny-btn">Search</button></form>{results.map(x=><div className="track-line result" key={x.id}><div className="thumb">{x.album?.cover_medium?<img src={x.album.cover_medium} alt=""/>:"♪"}</div><div className="track-copy"><strong>{x.title}</strong><small>{x.artist?.name} · {x.album?.title}</small></div><button className="tiny-btn" onClick={()=>onPlay({...normalize(x),id:null})}>▶</button><button className="tiny-btn" onClick={()=>onAdd({id:x.id})}>+</button></div>)}</>}
function AlbumView({albums,history,onPlay}){return <><div className="toolbar"><strong>Album cache</strong></div><div className="empty">Recently played</div>{history.map(a=><div className="track-line" key={`h-${a.album_id}`}><div className="thumb">{a.artwork_url?<img src={a.artwork_url} alt=""/>:"♪"}</div><div className="track-copy"><strong>{a.title}</strong><small>{a.artist}</small></div><button className="tiny-btn" onClick={()=>onPlay(a)}>Play album</button></div>)}<div className="empty">Cached albums</div>{albums.map(a=><div className="track-line" key={a.id}><div className="thumb">{a.artwork_url?<img src={a.artwork_url} alt=""/>:"♪"}</div><div className="track-copy"><strong>{a.title}</strong><small>{a.artist} · {a.track_count} tracks</small></div><button className="tiny-btn" onClick={()=>onPlay(a)}>Play album</button></div>)}</>}
function QueueView({tracks,current,mode,onPlay,onNext}){return <><div className="toolbar"><strong>{mode} queue · {tracks.length}</strong><button className="tiny-btn" onClick={onNext}>Next</button></div>{tracks.map((t,i)=><div className={`track-line ${current?.id===t.id?"selected":""}`} key={t.id||i}><div className="track-copy"><strong>{t.title}</strong><small>{t.artist} · {t.album_name||""}</small></div><button className="tiny-btn" onClick={()=>onPlay(t)}>▶</button></div>)}</>}
function Settings({subtab,setSubtab,onExport,onImport,onDelete,mode}){return <><div className="menu-list">{[["params","Params"],["csv","Download tracklist as CSV"],["delete","Delete data"],["upload","Upload data from CSV"]].map(([k,v])=><button key={k} className={`menu-row ${subtab===k?"selected":""}`} onClick={()=>setSubtab(k)}><span>{v}</span><span className="arrow">›</span></button>)}</div>{subtab==="params"&&<div className="empty">Playback mode: <strong>{mode}</strong><br/>API: <code>{API||"same-origin"}</code></div>}{subtab==="csv"&&<div className="toolbar"><button className="tiny-btn" onClick={onExport}>Download CSV</button></div>}{subtab==="upload"&&<div className="toolbar"><button className="tiny-btn" onClick={onImport}>Choose CSV</button></div>}{subtab==="delete"&&<div className="empty"><button className="tiny-btn" onClick={onDelete}>DELETE ALL DATA</button></div>}</>}

createRoot(document.getElementById("root")).render(<App/>);

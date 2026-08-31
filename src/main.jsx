import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API = import.meta.env.VITE_QUEUE_API_URL?.replace(/\/$/, "") || "";

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.body && typeof options.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `API error ${res.status}`);
  }
  return res;
}
const json = async (path, options) => (await request(path, options)).json();

function deezerTrack(x) {
  return { title:x.title, artist:x.artist?.name||"Unknown artist", album_id:x.album?.id??null, album_name:x.album?.title??null, source:"deezer", source_id:String(x.id), source_url:`https://www.deezer.com/track/${x.id}`, artwork_url:x.album?.cover_xl||x.album?.cover_medium||null, duration_ms:Number(x.duration||0)*1000, metadata_json:{deezer:x} };
}

function App() {
  const [tab,setTab]=useState("Now Playing"), [settingsTab,setSettingsTab]=useState("params"), [mode,setMode]=useState("track");
  const [current,setCurrent]=useState(null), [tracks,setTracks]=useState([]), [playlist,setPlaylist]=useState([]), [albums,setAlbums]=useState([]), [history,setHistory]=useState([]), [queue,setQueue]=useState([]), [results,setResults]=useState([]), [query,setQuery]=useState(""), [message,setMessage]=useState(""), [busy,setBusy]=useState(false);
  const audio=useRef(null), upload=useRef(null);
  const tabs=["Now Playing","Playlist","Search","Album","Queue","Settings"];

  async function refreshAll(){try{const[t,p,a,h]=await Promise.all([json("/api/library/tracks?limit=2000"),json("/api/playlist"),json("/api/library/albums?limit=1000"),json("/api/albums/history")]);setTracks(t.tracks||[]);setPlaylist(p.tracks||[]);setAlbums(a.albums||[]);setHistory(h.albums||[]);}catch(e){setMessage(e.message)}}
  async function refreshQueue(){try{const d=await json(`/api/queue?queue_key=${mode==="album"?"album-current":"default"}`);setQueue(d.tracks||[]);}catch(e){setMessage(e.message)}}
  useEffect(()=>{refreshAll()},[]); useEffect(()=>{refreshQueue()},[mode]);

  async function switchMode(nextMode){
    if(nextMode===mode)return true;
    const label=nextMode==="album"?"album mode":"track mode";
    if(!window.confirm(`Move the device to ${label}?\nThe current playback session will be replaced.`))return false;
    try{await json("/api/playback/mode",{method:"POST",body:JSON.stringify({mode:nextMode})});setMode(nextMode);setQueue([]);setCurrent(null);setMessage(`Device moved to ${label}`);return true}catch(e){setMessage(e.message);return false}
  }

  async function playTrack(track){if(!(await switchMode("track")))return;try{setBusy(true);const resolved=track.id?track:await json("/api/tracks/resolve",{method:"POST",body:JSON.stringify(track)});const id=resolved.track_id||resolved.id;const full=resolved.track_id?{...track,id}:resolved;await json("/api/play/track",{method:"POST",body:JSON.stringify({track_id:id})});setCurrent(full);setTab("Now Playing");setTimeout(()=>audio.current?.play().catch(()=>{}),50);await refreshAll();await refreshQueue()}catch(e){setMessage(e.message)}finally{setBusy(false)}}
  async function playAlbum(album){if(!(await switchMode("album")))return;try{setBusy(true);const d=await json(`/api/play/album/${album.id}`,{method:"POST"});setQueue(d.tracks||[]);setCurrent(d.tracks?.[0]||null);setTab("Now Playing");setMessage(`Album mode · ${album.title}`);setTimeout(()=>audio.current?.play().catch(()=>{}),50);await refreshAll();await refreshQueue()}catch(e){setMessage(e.message)}finally{setBusy(false)}}
  async function next(){const rows=queue.length?queue:(mode==="track"?playlist:[]);if(!rows.length)return;const i=Math.max(0,rows.findIndex(x=>x.id===current?.id));await playTrack(rows[(i+1)%rows.length])}
  async function search(e){e.preventDefault();if(!query.trim())return;try{setBusy(true);const d=await json(`/api/search?q=${encodeURIComponent(query.trim())}&limit=25`);setResults(d.data||[])}catch(e){setMessage(e.message)}finally{setBusy(false)}}
  async function addToPlaylist(item){try{const t=deezerTrack(item);const r=await json("/api/tracks/resolve",{method:"POST",body:JSON.stringify(t)});await json("/api/playlist",{method:"POST",body:JSON.stringify({track_id:r.track_id})});setMessage(`Added ${t.title} to playlist`);await refreshAll()}catch(e){setMessage(e.message)}}
  async function removePlaylist(id){try{await request(`/api/playlist/${id}`,{method:"DELETE"});await refreshAll()}catch(e){setMessage(e.message)}}
  async function exportCsv(){const r=await request("/api/export/tracks.csv");const b=await r.blob(),u=URL.createObjectURL(b),a=document.createElement("a");a.href=u;a.download="tracks.csv";a.click();URL.revokeObjectURL(u)}
  async function importCsv(e){const f=e.target.files?.[0];if(!f)return;try{const d=await json("/api/import/tracks.csv",{method:"POST",headers:{"Content-Type":"text/csv"},body:await f.text()});setMessage(`Imported ${d.imported||0} tracks`);await refreshAll()}catch(e){setMessage(e.message)}e.target.value=""}
  async function deleteData(){if(!window.confirm("Delete all tracks, playlist, queues, cache and acquisition data? This cannot be undone."))return;try{await json("/api/data/delete",{method:"POST",body:JSON.stringify({confirm:"DELETE"})});setCurrent(null);setQueue([]);setMessage("All data deleted");await refreshAll()}catch(e){setMessage(e.message)}}

  return <main className="ipod-page"><section className="ipod"><div className="screen"><header className="screen-top"><span>daksh music</span><span className="mode-pill">{mode}</span></header><div className="screen-body">{message&&<div className="banner">{message}</div>}<nav className="tabs">{tabs.map(t=><button key={t} className={tab===t?"active":""} onClick={()=>setTab(t)}>{t}</button>)}</nav><section className="window">
    {tab==="Now Playing"&&<NowPlaying current={current} mode={mode} audio={audio} next={next}/>} {tab==="Playlist"&&<Playlist rows={playlist} play={playTrack} remove={removePlaylist}/>} {tab==="Search"&&<Search query={query} setQuery={setQuery} submit={search} results={results} play={playTrack} add={addToPlaylist} busy={busy}/>} {tab==="Album"&&<AlbumView albums={albums} history={history} play={playAlbum}/>} {tab==="Queue"&&<Queue rows={queue} current={current} mode={mode} play={playTrack} next={next}/>} {tab==="Settings"&&<Settings sub={settingsTab} setSub={setSettingsTab} mode={mode} exportCsv={exportCsv} importCsv={()=>upload.current?.click()} deleteData={deleteData}/>}</section><input ref={upload} hidden type="file" accept=".csv,text/csv" onChange={importCsv}/></div></div><div className="wheel-area"><div className="wheel"><button className="menu" onClick={()=>setTab("Now Playing")}>MENU</button><button className="prev" onClick={()=>setTab("Playlist")}>‹</button><button className="next" onClick={next}>›</button><button className="play" onClick={()=>audio.current?.paused?audio.current?.play():audio.current?.pause()}>▶❙❙</button><button className="center" onClick={()=>setTab("Now Playing")}/></div><div className="click-hint">{mode.toUpperCase()} MODE · SELECT</div></div><div className="footer">daksh music · {tracks.length} tracks · {albums.length} albums</div></section></main>;
}

function NowPlaying({current,mode,audio,next}){const preview=current?.metadata_json?.deezer?.preview;return <div className="now-playing"><div className="art">{current?.artwork_url?<img src={current.artwork_url} alt=""/>:"♪"}</div><div className="np-info"><small>{mode.toUpperCase()} MODE</small><h2>{current?.title||"Nothing playing"}</h2><strong>{current?.artist||"—"}</strong><small>{current?.album_name||"—"}</small><div className="toolbar"><button className="tiny-btn" onClick={()=>audio.current?.paused?audio.current?.play():audio.current?.pause()}>Play / Pause</button><button className="tiny-btn" onClick={next}>Next</button></div>{preview?<audio ref={audio} src={preview} controls onEnded={next}/>:<small>No Deezer preview available</small>}</div></div>}
function Playlist({rows,play,remove}){return <div><div className="section-head"><h2>Playlist</h2><span>{rows.length} tracks</span></div>{rows.length?rows.map(r=><div className="track-line" key={r.playlist_entry_id}><div className="track-copy" onClick={()=>play(r)}><strong>{r.title}</strong><small>{r.artist} · {r.album_name||"Unknown album"}</small></div><button className="tiny-btn" onClick={()=>play(r)}>▶</button><button className="tiny-btn" onClick={()=>remove(r.playlist_entry_id)}>×</button></div>):<div className="empty">Playlist is empty.</div>}</div>}
function Search({query,setQuery,submit,results,play,add,busy}){return <div><div className="section-head"><h2>Search</h2><span>Deezer</span></div><form className="toolbar" onSubmit={submit}><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Song, artist, album…"/><button className="tiny-btn">Search</button></form>{busy&&<div className="empty">Searching…</div>}{!busy&&results.map(x=><div className="track-line" key={x.id}><div className="thumb">{x.album?.cover_medium?<img src={x.album.cover_medium} alt=""/>:"♪"}</div><div className="track-copy"><strong>{x.title}</strong><small>{x.artist?.name} · {x.album?.title}</small></div><button className="tiny-btn" onClick={()=>play(deezerTrack(x))}>▶</button><button className="tiny-btn" onClick={()=>add(x)}>+</button></div>)}</div>}
function AlbumView({albums,history,play}){return <div><div className="section-head"><h2>Album</h2><span>{albums.length} cached</span></div>{history.length>0&&<><div className="subhead">Last 5 played</div>{history.map(a=><AlbumRow key={`h-${a.album_id}`} album={a} play={play}/>)}</>}{albums.length?albums.map(a=><AlbumRow key={a.id} album={a} play={play}/>):<div className="empty">No album cache.</div>}</div>}
function AlbumRow({album,play}){return <div className="track-line"><div className="thumb">{album.artwork_url?<img src={album.artwork_url} alt=""/>:"♪"}</div><div className="track-copy"><strong>{album.title}</strong><small>{album.artist||"Unknown artist"}{album.track_count!=null?` · ${album.track_count} tracks`:""}</small></div><button className="tiny-btn" onClick={()=>play(album)}>Play album</button></div>}
function Queue({rows,current,mode,play,next}){return <div><div className="section-head"><h2>Queue</h2><span>{mode} · {rows.length}</span><button className="tiny-btn" onClick={next}>Next</button></div>{rows.length?rows.map((r,i)=><div className={`track-line ${current?.id===r.id?"selected":""}`} key={r.queue_entry_id||r.id||i}><div className="track-copy"><strong>{r.title}</strong><small>{r.artist} · {r.album_name||""}</small></div><button className="tiny-btn" onClick={()=>play(r)}>▶</button></div>):<div className="empty">Queue is empty.</div>}</div>}
function Settings({sub,setSub,mode,exportCsv,importCsv,deleteData}){const items=[["params","Params"],["csv","Download tracklist as CSV"],["delete","Delete data"],["upload","Upload data from CSV"]];return <div><div className="section-head"><h2>Settings</h2></div><div className="settings-list">{items.map(([k,label])=><button key={k} className={sub===k?"selected":""} onClick={()=>setSub(k)}>{label}<span>›</span></button>)}</div>{sub==="params"&&<div className="settings-card"><b>Playback mode:</b> {mode}<br/><b>API:</b> {API||"same-origin"}<br/><b>Storage:</b> D1 metadata + device/R2 cache</div>}{sub==="csv"&&<div className="settings-card"><button className="tiny-btn" onClick={exportCsv}>Download tracklist.csv</button></div>}{sub==="upload"&&<div className="settings-card"><button className="tiny-btn" onClick={importCsv}>Choose CSV</button></div>}{sub==="delete"&&<div className="settings-card danger"><p>This deletes the D1 library and playback state.</p><button className="tiny-btn" onClick={deleteData}>DELETE ALL DATA</button></div>}</div>}

createRoot(document.getElementById("root")).render(<App/>);

import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API = import.meta.env.VITE_QUEUE_API_URL?.replace(/\/$/, "") || "";

const request = async (path, options = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": options.headers?.["Content-Type"] || "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw Error(d.error || `API error ${r.status}`);
  }
  return r;
};
const json = async (path, options = {}) => (await request(path, options)).json();

const deezerTrack = (x) => ({
  title: x.title,
  artist: x.artist?.name || "Unknown artist",
  album_id: null,
  album_name: x.album?.title ?? null,
  source: "deezer",
  source_id: String(x.id),
  source_url: `https://www.deezer.com/track/${x.id}`,
  artwork_url: x.album?.cover_xl || x.album?.cover_medium || null,
  duration_ms: Number(x.duration || 0) * 1000,
  metadata_json: { deezer: x, deezer_album_id: x.album?.id ?? null },
});

const getMeta = (t) => {
  if (!t) return null;
  let m = t.metadata_json;
  if (typeof m === "string") {
    try { m = JSON.parse(m); } catch { m = null; }
  }
  return m;
};
const getPreview = (t) => getMeta(t)?.deezer?.preview || null;
const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

const MENU_ITEMS = [
  { key: "Now Playing", label: "Now Playing", icon: "disc" },
  { key: "Playlist", label: "Playlist", icon: "list" },
  { key: "Search", label: "Search", icon: "search" },
  { key: "Album", label: "Albums", icon: "grid" },
  { key: "Queue", label: "Queue", icon: "queue" },
  { key: "Settings", label: "Settings", icon: "settings" },
];

function Icon({ name, size = 20, ...rest }) {
  const s = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", ...rest };
  switch (name) {
    case "disc": return <svg {...s}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" /></svg>;
    case "list": return <svg {...s}><line x1="8" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="8" y1="18" x2="20" y2="18" /><circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none" /><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none" /></svg>;
    case "search": return <svg {...s}><circle cx="11" cy="11" r="7" /><line x1="16.6" y1="16.6" x2="21" y2="21" /></svg>;
    case "grid": return <svg {...s}><rect x="4" y="4" width="7" height="7" rx="1.4" /><rect x="13" y="4" width="7" height="7" rx="1.4" /><rect x="4" y="13" width="7" height="7" rx="1.4" /><rect x="13" y="13" width="7" height="7" rx="1.4" /></svg>;
    case "queue": return <svg {...s}><path d="M4 6h11" /><path d="M4 12h11" /><path d="M4 18h7" /><path d="M17 15l4 3-4 3z" fill="currentColor" stroke="none" /></svg>;
    case "settings": return <svg {...s}><circle cx="12" cy="12" r="3" /><path d="M19.4 13a7.9 7.9 0 000-2l2-1.5-2-3.4-2.4.6a8 8 0 00-1.7-1l-.4-2.5h-4l-.4 2.5a8 8 0 00-1.7 1l-2.4-.6-2 3.4L6.6 11a7.9 7.9 0 000 2l-2 1.5 2 3.4 2.4-.6a8 8 0 001.7 1l.4 2.5h4l.4-2.5a8 8 0 001.7-1l2.4.6 2-3.4z" /></svg>;
    case "play": return <svg {...s}><path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none" /></svg>;
    case "pause": return <svg {...s}><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /></svg>;
    case "next": return <svg {...s}><path d="M6 5l10 7-10 7z" fill="currentColor" stroke="none" /><rect x="17" y="5" width="2.4" height="14" rx="1" fill="currentColor" stroke="none" /></svg>;
    case "prev": return <svg {...s}><path d="M18 5L8 12l10 7z" fill="currentColor" stroke="none" /><rect x="4.6" y="5" width="2.4" height="14" rx="1" fill="currentColor" stroke="none" /></svg>;
    case "plus": return <svg {...s}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
    case "x": return <svg {...s}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>;
    case "chevron-left": return <svg {...s}><path d="M15 6l-6 6 6 6" /></svg>;
    case "chevron-right": return <svg {...s}><path d="M9 6l6 6-6 6" /></svg>;
    case "upload": return <svg {...s}><path d="M12 16V4" /><path d="M6 10l6-6 6 6" /><path d="M4 20h16" /></svg>;
    case "download": return <svg {...s}><path d="M12 4v12" /><path d="M6 12l6 6 6-6" /><path d="M4 20h16" /></svg>;
    case "trash": return <svg {...s}><path d="M5 7h14" /><path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" /><path d="M7 7l1 13h8l1-13" /></svg>;
    case "note": return <svg {...s}><path d="M9 18V5l10-2v13" /><circle cx="7" cy="18" r="2.4" fill="currentColor" stroke="none" /><circle cx="17" cy="16" r="2.4" fill="currentColor" stroke="none" /></svg>;
    default: return null;
  }
}

function App() {
  const [windowName, setWindowName] = useState("home");
  const [menuIndex, setMenuIndex] = useState(0);
  const [mode, setMode] = useState("track");
  const [current, setCurrent] = useState(null);
  const [playlist, setPlaylist] = useState([]);
  const [albums, setAlbums] = useState([]);
  const [history, setHistory] = useState([]);
  const [queue, setQueue] = useState([]);
  const [results, setResults] = useState([]);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [settingsTab, setSettingsTab] = useState("params");
  const [busy, setBusy] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playedSec, setPlayedSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [clock, setClock] = useState(() => new Date());
  const audio = useRef(null), upload = useRef(null), wheelStart = useRef(null);

  useEffect(() => { const id = setInterval(() => setClock(new Date()), 30000); return () => clearInterval(id); }, []);
  useEffect(() => { if (!message) return; const t = setTimeout(() => setMessage(""), 2600); return () => clearTimeout(t); }, [message]);

  const refresh = async () => {
    try {
      const [p, a, h] = await Promise.all([json("/api/playlist"), json("/api/library/albums?limit=1000"), json("/api/albums/history")]);
      setPlaylist(p.tracks || []); setAlbums(a.albums || []); setHistory(h.albums || []);
    } catch (e) { setMessage(e.message); }
  };
  const refreshQueue = async () => {
    try {
      const key = mode === "album" ? "album-current" : "default";
      const d = await json(`/api/queue?queue_key=${key}`);
      setQueue(d.tracks || []);
    } catch (e) { setMessage(e.message); }
  };
  useEffect(() => { refresh(); refreshQueue(); }, []);
  useEffect(() => { refreshQueue(); }, [mode]);

  const rows = () => (queue.length ? queue : playlist);
  const next = async () => {
    const r = rows(); if (!r.length) return;
    const i = Math.max(0, r.findIndex((x) => x.id === current?.id));
    await playTrack(r[(i + 1) % r.length]);
  };
  const prev = async () => {
    const r = rows(); if (!r.length) return;
    const i = Math.max(0, r.findIndex((x) => x.id === current?.id));
    await playTrack(r[(i - 1 + r.length) % r.length]);
  };

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    const onTime = () => setPlayedSec(el.currentTime || 0);
    const onMeta = () => setDurationSec(el.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnd = () => { setIsPlaying(false); next(); };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnd);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnd);
    };
  }, [current, queue, playlist]);

  const open = (name) => { setWindowName(name); setMenuIndex(Math.max(0, MENU_ITEMS.findIndex((m) => m.key === name))); };
  const home = () => setWindowName("home");
  const moveMenu = (d) => setMenuIndex((i) => (i + d + MENU_ITEMS.length) % MENU_ITEMS.length);
  const selectMenu = (index) => open(MENU_ITEMS[index ?? menuIndex].key);

  const handleWheelPointerDown = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    wheelStart.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const handleWheelPointerUp = (e) => {
    const s = wheelStart.current; if (!s) return;
    wheelStart.current = null;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dy) > 20 && Math.abs(dy) > Math.abs(dx)) { moveMenu(dy > 0 ? -1 : 1); return; }
    if (Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy) && windowName !== "home") { dx > 0 ? home() : open("Now Playing"); return; }
    if (windowName === "home" && Math.abs(dx) < 20 && Math.abs(dy) < 20) selectMenu();
  };

  const switchMode = async (target) => {
    if (target === mode) return true;
    if (!confirm(`Move device to ${target} mode?\nThe current playback session will be replaced.`)) return false;
    try {
      await json("/api/playback/mode", { method: "POST", body: JSON.stringify({ mode: target }) });
      setMode(target); setCurrent(null); setQueue([]); setMessage(`${target.toUpperCase()} MODE`);
      return true;
    } catch (e) { setMessage(e.message); return false; }
  };

  const playTrack = async (track) => {
    if (!(await switchMode("track"))) return;
    try {
      setBusy(true);
      const r = track.id ? { track_id: track.id } : await json("/api/tracks/resolve", { method: "POST", body: JSON.stringify(track) });
      const id = r.track_id || r.id;
      await json("/api/play/track", { method: "POST", body: JSON.stringify({ track_id: id }) });
      setCurrent({ ...track, id });
      open("Now Playing");
      setTimeout(() => audio.current?.play().catch(() => {}), 50);
      await refresh(); await refreshQueue();
    } catch (e) { setMessage(e.message); } finally { setBusy(false); }
  };

  const playAlbum = async (album) => {
    if (!(await switchMode("album"))) return;
    try {
      setBusy(true);
      const d = await json(`/api/play/album/${album.id}`, { method: "POST" });
      setCurrent(d.tracks?.[0] || null);
      open("Now Playing");
      setMessage(`Album · ${album.title}`);
      await refresh(); await refreshQueue();
      setTimeout(() => audio.current?.play().catch(() => {}), 50);
    } catch (e) { setMessage(e.message); } finally { setBusy(false); }
  };

  const togglePlay = () => { if (!audio.current) return; audio.current.paused ? audio.current.play().catch(() => {}) : audio.current.pause(); };
  const seek = (frac) => { if (!audio.current || !durationSec) return; audio.current.currentTime = frac * durationSec; };

  const search = async (e) => {
    e.preventDefault(); if (!query.trim()) return;
    try { setBusy(true); const d = await json(`/api/search?q=${encodeURIComponent(query.trim())}&limit=25`); setResults(d.data || []); }
    catch (e) { setMessage(e.message); } finally { setBusy(false); }
  };
  const add = async (x) => {
    try {
      const t = deezerTrack(x);
      const r = await json("/api/tracks/resolve", { method: "POST", body: JSON.stringify(t) });
      await json("/api/playlist", { method: "POST", body: JSON.stringify({ track_id: r.track_id }) });
      setMessage(`Added ${t.title}`); await refresh();
    } catch (e) { setMessage(e.message); }
  };
  const remove = async (id) => { try { await request(`/api/playlist/${id}`, { method: "DELETE" }); await refresh(); } catch (e) { setMessage(e.message); } };
  const exportCsv = async () => {
    const r = await request("/api/export/tracks.csv"), b = await r.blob(), u = URL.createObjectURL(b), a = document.createElement("a");
    a.href = u; a.download = "tracks.csv"; a.click(); URL.revokeObjectURL(u);
  };
  const importCsv = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const r = await request("/api/import/tracks.csv", { method: "POST", headers: { "Content-Type": "text/csv" }, body: await f.text() });
      const d = await r.json();
      setMessage(`Imported ${d.imported || 0}`); await refresh();
    } catch (e) { setMessage(e.message); }
    e.target.value = "";
  };
  const deleteData = async () => {
    if (!confirm("Delete all data? This cannot be undone.")) return;
    try {
      await json("/api/data/delete", { method: "POST", body: JSON.stringify({ confirm: "DELETE" }) });
      setCurrent(null); setQueue([]); setMessage("Data deleted"); await refresh();
    } catch (e) { setMessage(e.message); }
  };

  const preview = getPreview(current);

  return (
    <main className="ipod-page">
      <section className="ipod">
        <div className="screen">
          <audio ref={audio} src={preview || undefined} preload="none" />
          <header className="status-bar">
            <button type="button" className="brand" onClick={home}>daksh music</button>
            <span className="status-right">
              <span className="time">{clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              <span className={`live-dot ${isPlaying ? "on" : ""}`} />
            </span>
          </header>

          {message && <div className="toast">{message}</div>}

          {windowName !== "home" && (
            <div className="window-header">
              <button type="button" onClick={home} aria-label="Back"><Icon name="chevron-left" size={20} /></button>
              <strong>{MENU_ITEMS.find((m) => m.key === windowName)?.label}</strong>
              <span />
            </div>
          )}

          <div className="screen-body">
            {windowName === "home" && <Home items={MENU_ITEMS} index={menuIndex} onSelect={selectMenu} />}
            {windowName === "Now Playing" && (
              <NowPlaying current={current} mode={mode} isPlaying={isPlaying} playedSec={playedSec} durationSec={durationSec} togglePlay={togglePlay} next={next} prev={prev} seek={seek} preview={preview} />
            )}
            {windowName === "Playlist" && <Playlist playlist={playlist} play={playTrack} remove={remove} current={current} />}
            {windowName === "Search" && <Search query={query} setQuery={setQuery} search={search} results={results} play={playTrack} add={add} busy={busy} />}
            {windowName === "Album" && <Albums albums={albums} history={history} playAlbum={playAlbum} />}
            {windowName === "Queue" && <Queue queue={queue} current={current} play={playTrack} mode={mode} />}
            {windowName === "Settings" && <Settings settingsTab={settingsTab} setSettingsTab={setSettingsTab} mode={mode} exportCsv={exportCsv} upload={() => upload.current?.click()} deleteData={deleteData} />}
            <input ref={upload} hidden type="file" accept=".csv,text/csv" onChange={importCsv} />
          </div>
        </div>

        <div className="wheel-area">
          <div className="wheel" onPointerDown={handleWheelPointerDown} onPointerUp={handleWheelPointerUp} onPointerCancel={() => { wheelStart.current = null; }}>
            <button type="button" className="wheel-btn wheel-menu" onClick={(e) => { e.stopPropagation(); home(); }}>MENU</button>
            <button type="button" className="wheel-btn wheel-prev" aria-label="Previous track" onClick={(e) => { e.stopPropagation(); prev(); }}><Icon name="prev" size={16} /></button>
            <button type="button" className="wheel-btn wheel-next" aria-label="Next track" onClick={(e) => { e.stopPropagation(); next(); }}><Icon name="next" size={16} /></button>
            <button type="button" className="wheel-btn wheel-play" aria-label="Play or pause" onClick={(e) => { e.stopPropagation(); togglePlay(); }}><Icon name={isPlaying ? "pause" : "play"} size={16} /></button>
            <button
              type="button"
              className="wheel-center"
              aria-label="Select"
              onClick={(e) => { e.stopPropagation(); windowName === "home" ? selectMenu() : togglePlay(); }}
            />
          </div>
        </div>
        <footer className="footer">daksh music · {mode} mode</footer>
      </section>
    </main>
  );
}

function Home({ items, index, onSelect }) {
  return (
    <nav className="menu-list">
      {items.map((item, i) => (
        <button type="button" key={item.key} className={`menu-row ${i === index ? "selected" : ""}`} onClick={() => onSelect(i)}>
          <span className="menu-row-icon"><Icon name={item.icon} size={16} /></span>
          <span className="menu-row-label">{item.label}</span>
          <Icon name="chevron-right" size={16} />
        </button>
      ))}
    </nav>
  );
}

function NowPlaying({ current, mode, isPlaying, playedSec, durationSec, togglePlay, next, prev, seek, preview }) {
  const pct = durationSec ? Math.min(100, (playedSec / durationSec) * 100) : 0;
  const onScrub = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seek(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  };
  return (
    <div className="now-playing">
      <div className="np-bg" style={current?.artwork_url ? { backgroundImage: `url(${current.artwork_url})` } : undefined} />
      <div className="np-content">
        <div className="np-art">{current?.artwork_url ? <img src={current.artwork_url} alt="" /> : <Icon name="note" size={36} />}</div>
        <div className="np-meta">
          <strong>{current?.title || "Nothing playing"}</strong>
          <small>{current?.artist || "Select a song from the menu"}</small>
          {current?.album_name && <small className="np-album">{current.album_name}</small>}
        </div>
        <div className="np-progress" onClick={onScrub}><div className="np-progress-fill" style={{ width: `${pct}%` }} /></div>
        <div className="np-times"><span>{fmtTime(playedSec)}</span><span>{fmtTime(durationSec)}</span></div>
        <div className="np-controls">
          <button type="button" className="round-btn lg" onClick={prev}><Icon name="prev" size={16} /></button>
          <button type="button" className="round-btn xl accent" onClick={togglePlay}><Icon name={isPlaying ? "pause" : "play"} size={22} /></button>
          <button type="button" className="round-btn lg" onClick={next}><Icon name="next" size={16} /></button>
        </div>
        {current && !preview && <small className="np-note">No preview available for this track</small>}
        <small className="np-mode">{mode} mode</small>
      </div>
    </div>
  );
}

function Playlist({ playlist, play, remove, current }) {
  return (
    <div className="list">
      {playlist.length ? playlist.map((r) => (
        <div className={`row ${current?.id === r.id ? "active" : ""}`} key={r.playlist_entry_id}>
          <button type="button" className="row-tap" onClick={() => play(r)}>
            <span className="row-thumb">{r.artwork_url ? <img src={r.artwork_url} alt="" /> : <Icon name="note" size={16} />}</span>
            <span className="row-copy"><strong>{r.title}</strong><small>{r.artist} · {r.album_name || "Unknown album"}</small></span>
          </button>
          <button type="button" className="icon-btn" onClick={() => remove(r.playlist_entry_id)}><Icon name="x" size={16} /></button>
        </div>
      )) : <Empty text="Your playlist is empty" />}
    </div>
  );
}

function Search({ query, setQuery, search, results, play, add, busy }) {
  return (
    <div className="search-pane">
      <form className="search-bar" onSubmit={search}>
        <Icon name="search" size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Songs, artists, albums" />
      </form>
      {busy && <Empty text="Searching…" />}
      <div className="list">
        {results.map((x) => (
          <div className="row" key={x.id}>
            <button type="button" className="row-tap" onClick={() => play(deezerTrack(x))}>
              <span className="row-thumb">{x.album?.cover_medium ? <img src={x.album.cover_medium} alt="" /> : <Icon name="note" size={16} />}</span>
              <span className="row-copy"><strong>{x.title}</strong><small>{x.artist?.name} · {x.album?.title}</small></span>
            </button>
            <button type="button" className="icon-btn" onClick={() => add(x)}><Icon name="plus" size={16} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Albums({ albums, history, playAlbum }) {
  return (
    <div className="list">
      {history.length > 0 && <div className="section-label">Recently played</div>}
      {history.map((a) => <AlbumRow key={`h-${a.album_id}`} album={a} playAlbum={playAlbum} />)}
      {history.length > 0 && albums.length > 0 && <div className="section-label">Your library</div>}
      {albums.length ? albums.map((a) => <AlbumRow key={a.id} album={a} playAlbum={playAlbum} />) : (!history.length && <Empty text="No albums yet" />)}
    </div>
  );
}
function AlbumRow({ album, playAlbum }) {
  return (
    <div className="row">
      <button type="button" className="row-tap" onClick={() => playAlbum(album)}>
        <span className="row-thumb sq">{album.artwork_url ? <img src={album.artwork_url} alt="" /> : <Icon name="note" size={16} />}</span>
        <span className="row-copy"><strong>{album.title}</strong><small>{album.artist || "Unknown artist"}{album.track_count != null ? ` · ${album.track_count} tracks` : ""}</small></span>
      </button>
      <span className="icon-btn ghost"><Icon name="play" size={14} /></span>
    </div>
  );
}

function Queue({ queue, current, play, mode }) {
  return (
    <div className="list">
      {queue.length ? queue.map((r, i) => (
        <div className={`row ${current?.id === r.id ? "active" : ""}`} key={r.queue_entry_id || r.id || i}>
          <button type="button" className="row-tap" onClick={() => play(r)}>
            <span className="row-index">{i + 1}</span>
            <span className="row-copy"><strong>{r.title}</strong><small>{r.artist} · {r.album_name || ""}</small></span>
          </button>
        </div>
      )) : <Empty text={`${mode} queue is empty`} />}
    </div>
  );
}

function Settings({ settingsTab, setSettingsTab, mode, exportCsv, upload, deleteData }) {
  const items = [["params", "Playback"], ["csv", "Export library"], ["upload", "Import library"], ["delete", "Delete all data"]];
  return (
    <div className="settings">
      <div className="grouped-list">
        {items.map(([k, v]) => (
          <button type="button" key={k} className={`grouped-row ${settingsTab === k ? "active" : ""} ${k === "delete" ? "danger" : ""}`} onClick={() => setSettingsTab(k)}>
            <span>{v}</span><Icon name="chevron-right" size={14} />
          </button>
        ))}
      </div>
      {settingsTab === "params" && (
        <div className="card">
          <div className="kv"><span>Playback mode</span><strong>{mode}</strong></div>
          <div className="kv"><span>API endpoint</span><code>{API || "same-origin"}</code></div>
        </div>
      )}
      {settingsTab === "csv" && (
        <div className="card"><p>Download every track in your library as a CSV file.</p><button type="button" className="pill-btn" onClick={exportCsv}><Icon name="download" size={14} /> Download CSV</button></div>
      )}
      {settingsTab === "upload" && (
        <div className="card"><p>Import tracks from a CSV file into your library.</p><button type="button" className="pill-btn" onClick={upload}><Icon name="upload" size={14} /> Choose CSV</button></div>
      )}
      {settingsTab === "delete" && (
        <div className="card danger"><p>This permanently deletes your library, playlist, and playback history.</p><button type="button" className="pill-btn danger" onClick={deleteData}><Icon name="trash" size={14} /> Delete all data</button></div>
      )}
    </div>
  );
}

function Empty({ text }) { return <div className="empty">{text}</div>; }

createRoot(document.getElementById("root")).render(<App />);

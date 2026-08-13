(() => {
  const API = "/api/v1";
  const DEVICE_CACHE_NAME = "device-audio-v1";
  const DEVICE_CACHE_LIMIT = 10;

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* unsupported or blocked; app still works without it */ });
  }

  /* ---------- low-level API helpers (real endpoints) ---------- */

  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      credentials: "include",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
    if (!res.ok) { const err = new Error(data.error || `HTTP ${res.status}`); err.status = res.status; throw err; }
    return data;
  }

  const login = (password) => api("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
  const logout = () => api("/auth/logout", { method: "POST" }).catch(() => {});
  const searchTracks = (q) => api("/search?q=" + encodeURIComponent(q));
  const getPlaylist = () => api("/playlist");
  const addToPlaylist = (item) => api("/playlist", { method: "POST", body: JSON.stringify(item) });
  const removeFromPlaylist = (entryId) => api("/playlist/" + encodeURIComponent(entryId), { method: "DELETE" });
  const moveEntry = (entryId, position) => api("/playlist/" + encodeURIComponent(entryId), { method: "PATCH", body: JSON.stringify({ position }) });
  const clearPlaylist = () => api("/playlist", { method: "DELETE" });
  const getTop100 = () => api("/cache/top");
  const appleMusicImport = (items) => api("/apple-music/import", { method: "POST", body: JSON.stringify({ items }) });
  const clearAllData = (password) => api("/admin/clear-all", { method: "POST", body: JSON.stringify({ password }) });
  const searchAlbums = (q) => api("/albums/search?q=" + encodeURIComponent(q));
  const getStoredAlbums = () => api("/albums/stored");
  const getAlbum = (id) => api("/albums/" + encodeURIComponent(id));
  const acquireTrack = (trackId) => api(`/tracks/${encodeURIComponent(trackId)}/acquire`, { method: "POST" });
  const getJob = (jobId) => api("/jobs/" + encodeURIComponent(jobId));

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  }

  /* ---------- DOM refs ---------- */

  const screenTitle = document.getElementById("screenTitle");
  const statusbar = document.getElementById("statusbar");
  const loginWrap = document.getElementById("loginWrap");
  const toastEl = document.getElementById("toast");
  const audio = document.getElementById("audio");

  let toastTimer = null;
  function toast(msg, ms = 1800) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  /* ---------- navigation stack ---------- */

  const views = {};
  document.querySelectorAll(".view").forEach(v => { views[v.id.replace("view-", "")] = v; });

  let stack = [];
  let playlistCache = [];

  function showView(key) {
    Object.values(views).forEach(v => v.classList.remove("active"));
    if (views[key]) views[key].classList.add("active");
  }

  function current() { return stack[stack.length - 1]; }

  function push(screen) { stack.push(screen); renderCurrent(); }
  function pop() { if (stack.length <= 1) return; stack.pop(); renderCurrent(); }

  function renderCurrent() {
    const s = current();
    if (!s) return;
    screenTitle.textContent = s.title || "iPod";
    showView(s.key);
    if (s.kind === "menu") renderMenu(s);
    if (s.kind === "nowplaying") renderNowPlaying();
  }

  function renderMenu(s) {
    const listEl = document.getElementById("list-" + s.key);
    if (!listEl) return;
    if (!s.items.length) {
      listEl.innerHTML = `<li class="empty" style="display:block;border:none;padding-top:40px;white-space:pre-line">${esc(s.emptyText || "Nothing here yet")}</li>`;
      return;
    }
    listEl.innerHTML = s.items.map((it, i) => `
      <li data-i="${i}" class="${i === s.selected ? "sel" : ""}">
        ${it.html ? it.html : `
          <div class="l">
            ${it.dot ? `<span class="dot ${it.dot}"></span>` : ""}
            <span class="name">${esc(it.label)}</span>
          </div>
          ${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : `<span class="chev">${it.chev || (it.action ? "▸" : "")}</span>`}
        `}
      </li>
    `).join("");
    const sel = listEl.querySelector("li.sel");
    if (sel) sel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    listEl.querySelectorAll("li[data-i]").forEach(li => {
      li.addEventListener("click", (e) => {
        if (e.target.closest("[data-stop]")) return;
        s.selected = Number(li.dataset.i);
        renderMenu(s);
        selectCurrent();
      });
    });
    // secondary row actions (remove / move) that must not trigger row select
    listEl.querySelectorAll("[data-stop]").forEach(btn => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); });
    });
  }

  function moveSelection(delta) {
    const s = current();
    if (!s || s.kind !== "menu" || !s.items.length) return;
    s.selected = Math.max(0, Math.min(s.items.length - 1, (s.selected || 0) + delta));
    renderMenu(s);
  }

  function selectCurrent() {
    const s = current();
    if (!s) return;
    if (s.kind === "menu") {
      const item = s.items[s.selected];
      if (item && item.action) item.action();
    } else if (s.kind === "field") {
      if (s.onGo) s.onGo();
    } else if (s.kind === "nowplaying") {
      togglePlay();
    }
  }

  /* ---------- home ---------- */

  function openHome() {
    stack = [{
      key: "home", title: "daksh music", kind: "menu", selected: 0,
      items: [
        { label: "Queue", action: openQueue },
        { label: "Search", action: openSearch },
        { label: "Albums", action: openAlbums },
        { label: "Playlist", action: openPlaylist },
        { label: "Settings", action: openSettings },
      ],
    }];
    renderCurrent();
  }

  function openSettings() {
    push({
      key: "settings", title: "Settings", kind: "menu", selected: 0,
      items: [
        { label: "Top 100", action: openTop100 },
        { label: "Import Apple Music", action: openAppleImport },
        { label: "Import Library CSV", action: openLibraryCsvImport },
        { label: "Export Playlist Excel", action: exportPlaylistExcel },
        { label: "Device Cache", action: openDeviceCache },
        { label: "Clear Playlist", action: async () => {
            if (!confirm("Clear the entire playlist? Cached audio is kept.")) return;
            try { await clearPlaylist(); toast("Playlist cleared"); } catch (e) { toast(e.message); }
          } },
        { label: "Clear All Data", action: openClearAllData },
        { label: "Log Out", action: async () => { await logout(); location.reload(); } },
      ],
    });
  }

  /* ---------- on-device audio cache (Cache Storage API, shared with sw.js) ---------- */

  async function deviceCacheEntries() {
    if (!("caches" in window)) return [];
    try {
      const cache = await caches.open(DEVICE_CACHE_NAME);
      const keys = await cache.keys();
      return keys.filter(r => !r.url.includes("__meta__"));
    } catch { return []; }
  }

  async function openDeviceCache() {
    const s = { key: "devicecache", title: "Device Cache", kind: "menu", selected: 0, items: [], emptyText: "" };
    push(s);
    if (!("caches" in window)) {
      s.emptyText = "Your browser doesn't support on-device caching.";
      renderMenu(s);
      return;
    }
    const entries = await deviceCacheEntries();
    s.items = [
      { label: `${entries.length} of ${DEVICE_CACHE_LIMIT} slots used`, sub: "Most recently played tracks are kept offline" },
      { label: "Clear Device Cache", action: async () => {
          if (!confirm(`Remove ${entries.length} cached audio file(s) from this device? They'll re-download next time you play them.`)) return;
          try { await caches.delete(DEVICE_CACHE_NAME); toast("Device cache cleared"); await openDeviceCache(); }
          catch (e) { toast(e.message); }
        } },
    ];
    renderMenu(s);
  }

  /* ---------- playlist (edit-focused) ---------- */

  function playlistRowHtml(t, i, total) {
    return `
      <div class="l"><span class="name">${esc(t.title || "Untitled")}</span></div>
      <span class="sub">${esc(t.artist || "")}</span>
      <div class="row-actions" data-stop>
        <button data-stop title="Move up" ${i === 0 ? "disabled style='opacity:.3'" : ""} data-act="up">▲</button>
        <button data-stop title="Move down" ${i === total - 1 ? "disabled style='opacity:.3'" : ""} data-act="down">▼</button>
        <button data-stop class="remove" title="Remove" data-act="remove">×</button>
      </div>
    `;
  }

  function wirePlaylistRowActions(s, rows) {
    const listEl = document.getElementById("list-" + s.key);
    listEl.querySelectorAll("li[data-i]").forEach(li => {
      const i = Number(li.dataset.i);
      const row = rows[i];
      if (!row) return;
      const up = li.querySelector('[data-act="up"]');
      const down = li.querySelector('[data-act="down"]');
      const rm = li.querySelector('[data-act="remove"]');
      if (up) up.addEventListener("click", async (e) => { e.stopPropagation(); try { await moveEntry(row.entry_id, row.position - 1); await openPlaylist(); } catch (err) { toast(err.message); } });
      if (down) down.addEventListener("click", async (e) => { e.stopPropagation(); try { await moveEntry(row.entry_id, row.position + 1); await openPlaylist(); } catch (err) { toast(err.message); } });
      if (rm) rm.addEventListener("click", async (e) => { e.stopPropagation(); try { await removeFromPlaylist(row.entry_id); await openPlaylist(); } catch (err) { toast(err.message); } });
    });
  }

  async function openPlaylist() {
    const s = { key: "playlist", title: "Playlist", kind: "menu", selected: 0, items: [], emptyText: "Playlist is empty.\nAdd songs from Search or Albums." };
    push(s);
    try {
      const rows = await getPlaylist();
      playlistCache = rows;
      s.items = rows.map((t, i) => ({ html: playlistRowHtml(t, i, rows.length), action: () => playTrack(t, rows, "playlist") }));
      renderMenu(s);
      wirePlaylistRowActions(s, rows);
    } catch (e) { s.emptyText = e.message; renderMenu(s); }
  }

  /* ---------- queue (now playing + up next) ---------- */

  function miniPlayerHtml() {
    const t = nowPlayingTrack;
    const art = t?.artwork_url
      ? `<img src="${esc(t.artwork_url)}" alt="">`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    const state = overrideState || (t ? (audio.paused ? "Paused" : "Playing") : "");
    return `
      <div class="mini-player">
        <div class="mini-art">${art}</div>
        <div class="mini-info">
          <div class="mini-title">${t ? esc(t.title || "Untitled") : "Nothing playing"}</div>
          <div class="mini-sub">${t ? esc(t.artist || "") : "Select a song to play"}</div>
        </div>
        <div class="mini-state">${esc(state)}</div>
      </div>
    `;
  }

  async function openQueue() {
    const s = { key: "queue", title: "Queue", kind: "menu", selected: 0, items: [], emptyText: "" };
    push(s);
    try {
      const searchQueue = nowPlayingMode === "playlist" && Array.isArray(nowPlayingList) && nowPlayingList.length ? nowPlayingList : null;
      const rows = searchQueue || await getPlaylist();
      playlistCache = rows;
      const items = [{ html: miniPlayerHtml(), action: () => push(nowPlayingScreen()) }];
      let upNext = rows;
      if (nowPlayingTrack) {
        const idx = rows.findIndex(t => t.id === nowPlayingTrack.id);
        upNext = idx >= 0 ? rows.slice(idx + 1) : rows;
      }
      if (!upNext.length) {
        items.push({ label: rows.length ? "End of queue" : "Playlist is empty", sub: "" });
      } else {
        upNext.forEach(t => items.push({ label: t.title || "Untitled", sub: t.artist || "", action: () => playTrack(t, rows, "playlist") }));
      }
      s.items = items;
      renderMenu(s);
    } catch (e) { s.items = [{ label: "Couldn't load queue", sub: e.message }]; renderMenu(s); }
  }

  function refreshQueueHeaderIfVisible() {
    if (current()?.key === "queue" && current().items?.[0]) {
      current().items[0].html = miniPlayerHtml();
      renderMenu(current());
    }
  }

  /* ---------- top 100 ---------- */

  async function openTop100() {
    const s = { key: "top100", title: "Top 100", kind: "menu", selected: 0, items: [], emptyText: "No play-count data yet.\nImport Apple Music from Settings." };
    push(s);
    try {
      const d = await getTop100();
      s.items = (d.items || []).map(t => ({
        label: `${t.rank}. ${t.title || "Untitled"}`,
        sub: t.artist || "",
        dot: t.storage_key ? "ready" : "pending",
        action: () => playTrack(t, null),
      }));
    } catch (e) { s.emptyText = e.message; }
    renderMenu(s);
  }

  /* ---------- search (tracks) ---------- */

  function openSearch() {
    push({ key: "search", title: "Search", kind: "field", onGo: runSearch });
    setTimeout(() => document.getElementById("searchInput").focus(), 50);
  }

  async function runSearch() {
    const q = document.getElementById("searchInput").value.trim();
    const status = document.getElementById("searchStatus");
    if (!q) { status.textContent = "Type something to search."; return; }
    status.textContent = "Searching…";
    try {
      const d = await searchTracks(q);
      status.textContent = "";
      const s = { key: "searchresults", title: "Results", kind: "menu", selected: 0, items: [], emptyText: "No results." };
      s.items = (d.items || []).map(it => ({
        label: it.title || "Untitled", sub: it.artist || "",
        action: async () => {
          try { const r = await addToPlaylist(it); toast(r.already_present ? "Already in Playlist" : "Added to Playlist"); }
          catch (e) { toast(e.message); }
        },
      }));
      push(s);
    } catch (e) { status.textContent = e.message; }
  }

  /* ---------- albums ---------- */

  function openAlbums() {
    push({
      key: "albumsmenu", title: "Albums", kind: "menu", selected: 0,
      items: [
        { label: "Search Albums", action: openAlbumSearchField },
        { label: "Stored Albums", action: openStoredAlbums },
      ],
    });
  }

  function openAlbumSearchField() {
    push({ key: "albums", title: "Search Albums", kind: "field", onGo: runAlbumSearch });
    setTimeout(() => document.getElementById("albumInput").focus(), 50);
  }

  async function openStoredAlbums() {
    const s = { key: "storedalbums", title: "Stored Albums", kind: "menu", selected: 0, items: [], emptyText: "No albums cached yet.\nOpen one from Search Albums to cache it." };
    push(s);
    try {
      const d = await getStoredAlbums();
      s.items = (d.items || []).map(a => ({
        label: a.title || "Untitled Album",
        sub: `${a.artist || "Unknown artist"} · ${a.ready_tracks}/${a.total_tracks} ready`,
        action: () => openAlbumDetail(a.album_id),
      }));
      if (!s.items.length) s.emptyText = "No albums cached yet.\nOpen one from Search Albums to cache it.";
    } catch (e) { s.emptyText = e.message; }
    renderMenu(s);
  }

  async function runAlbumSearch() {
    const q = document.getElementById("albumInput").value.trim();
    const status = document.getElementById("albumStatus");
    if (!q) { status.textContent = "Type an album or artist name."; return; }
    status.textContent = "Searching…";
    try {
      const d = await searchAlbums(q);
      status.textContent = "";
      const s = { key: "albumresults", title: "Albums", kind: "menu", selected: 0, items: [], emptyText: "No albums found." };
      s.items = (d.items || []).map(al => ({
        label: al.title || "Untitled", sub: al.artist || "",
        action: () => openAlbumDetail(al.album_id),
      }));
      push(s);
    } catch (e) { status.textContent = e.message; }
  }

  async function openAlbumDetail(albumId) {
    const s = { key: "albumdetail", title: "Album", kind: "menu", selected: 0, items: [], emptyText: "Loading…" };
    push(s);
    try {
      const al = await getAlbum(albumId);
      s.title = al.title || "Album";
      const tracks = (al.tracks || []).filter(t => t.id != null);
      const items = [{
        label: "▸ Play Album", sub: `${tracks.length} track(s)`,
        action: () => { if (tracks.length) playTrack(tracks[0], tracks, "album"); },
      }];
      tracks.forEach(t => items.push({
        label: t.title || "Untitled", sub: fmtTime((t.duration_ms || 0) / 1000),
        action: () => playTrack(t, tracks, "album"),
      }));
      s.items = items;
      if (!tracks.length) s.emptyText = "No tracks in this album.";
      else warmAlbumOnDevice(tracks);
    } catch (e) { s.emptyText = e.message; s.items = []; }
    renderMenu(s);
  }

  function warmAlbumOnDevice(tracks) {
    // All tracks warmed concurrently, not one at a time -- an album is a
    // bounded, known-size set, unlike an open-ended playlist queue.
    for (const t of tracks) {
      if (t.id == null) continue;
      (async () => {
        try {
          const res = await acquireTrack(t.id);
          if (res.cached) { warmOnDeviceCache(t.id); return; }
          if (res.job_id) {
            const ok = await pollJobSilently(res.job_id);
            if (ok) warmOnDeviceCache(t.id);
          }
        } catch { /* best effort */ }
      })();
    }
  }

  /* ---------- clear all data ---------- */

  function openClearAllData() {
    push({ key: "clearall", title: "Clear All Data", kind: "field", onGo: runClearAllData });
    setTimeout(() => document.getElementById("clearAllPassword").focus(), 50);
  }

  async function runClearAllData() {
    const pwEl = document.getElementById("clearAllPassword");
    const status = document.getElementById("clearAllStatus");
    const password = pwEl.value;
    if (!password) { status.textContent = "Enter your password to confirm."; return; }
    status.textContent = "Clearing all data…";
    try {
      const res = await clearAllData(password);
      pwEl.value = "";
      status.textContent = `Cleared. Removed ${res.r2_objects_deleted} cached audio file(s).`;
      nowPlayingTrack = null;
      nowPlayingList = null;
      audio.pause();
      audio.removeAttribute("src");
      toast("All data cleared");
    } catch (e) { status.textContent = e.message; }
  }

  /* ---------- apple music import ---------- */

  function openAppleImport() {
    push({ key: "appleimport", title: "Apple Music", kind: "field", onGo: runAppleImport });
  }

  function playlistUrlId(url) {
    try { const u = new URL(url); const parts = u.pathname.split("/").filter(Boolean); return parts[parts.length - 1] || null; }
    catch { return null; }
  }

  async function appleFetch(url, developerToken, userToken) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${developerToken}`, "Music-User-Token": userToken } });
    const text = await r.text();
    if (!r.ok) throw new Error(`Apple Music API ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  async function findLibraryPlaylist(developerToken, userToken, inputUrl) {
    const wanted = playlistUrlId(inputUrl);
    let next = "https://api.music.apple.com/v1/me/library/playlists?limit=100";
    while (next) {
      const d = await appleFetch(next, developerToken, userToken);
      for (const p of d.data || []) {
        if (wanted && (String(p.id) === String(wanted) || p.attributes?.url === inputUrl)) return p;
      }
      next = d.next ? (d.next.startsWith("http") ? d.next : `https://api.music.apple.com${d.next}`) : null;
    }
    return null;
  }

  async function runAppleImport() {
    const status = document.getElementById("appleStatus");
    const developerToken = document.getElementById("appleDevToken").value.trim();
    const inputUrl = document.getElementById("applePlaylistUrl").value.trim();
    if (!developerToken || !inputUrl) { status.textContent = "Enter a developer token and playlist URL."; return; }
    try {
      status.textContent = "Authorizing Apple Music…";
      if (!window.MusicKit) throw new Error("MusicKit JS did not load");
      MusicKit.configure({ developerToken, app: { name: "daksh music", build: "1.0" } });
      const music = MusicKit.getInstance();
      const userToken = await music.authorize();
      status.textContent = "Finding your library playlist…";
      const playlist = await findLibraryPlaylist(developerToken, userToken, inputUrl);
      if (!playlist) throw new Error("Playlist not found. Add it to your library first.");
      let next = `https://api.music.apple.com/v1/me/library/playlists/${encodeURIComponent(playlist.id)}/tracks?limit=100`;
      const items = [];
      while (next) {
        const d = await appleFetch(next, developerToken, userToken);
        for (const x of d.data || []) {
          const a = x.attributes || {};
          items.push({ title: a.name, artist: a.artistName || "", album: a.albumName || null, play_count: Number(a.playCount || 0) });
        }
        next = d.next ? (d.next.startsWith("http") ? d.next : `https://api.music.apple.com${d.next}`) : null;
      }
      if (!items.length) throw new Error("No tracks found in that playlist.");
      status.textContent = `Sending ${items.length} tracks…`;
      const result = await appleMusicImport(items);
      status.textContent = `Imported ${result.imported}. ${result.unmatched?.length || 0} unmatched.`;
      toast("Top 100 updated");
    } catch (e) { status.textContent = e.message; }
  }

  /* ---------- now playing + acquisition ---------- */

  let nowPlayingTrack = null;
  let nowPlayingList = null;
  let overrideState = null;
  let pendingTrackId = null;
  let pollGeneration = 0;

  function nowPlayingScreen() { return { key: "nowplaying", title: "Now Playing", kind: "nowplaying" }; }

  function setNpState(text) {
    overrideState = text;
    renderNowPlayingStateOnly();
    refreshQueueHeaderIfVisible();
  }

  const QUEUE_WINDOW = 4;

  async function evictFromDeviceCache(trackId) {
    if (!("caches" in window) || trackId == null) return;
    try {
      const cache = await caches.open(DEVICE_CACHE_NAME);
      await cache.delete(`${location.origin}/api/v1/playback/${trackId}`);
    } catch { /* best effort */ }
  }

  function pruneQueueWindow(track, listContext, mode) {
    if (mode !== "playlist" || !listContext) return;
    const idx = listContext.findIndex(t => t.id === track.id);
    if (idx < QUEUE_WINDOW) return; // items 1-4 (index 0-3): no eviction yet
    // Reaching item 5 (index 4) evicts item 1 (index 0); reaching item 6
    // evicts item 2, and so on -- a trailing window of QUEUE_WINDOW items
    // (current + 3 previous) is always kept, enough for a few steps of
    // seamless "previous" without unbounded growth. Albums don't use this
    // at all -- the whole album is warmed upfront (see warmAlbumOnDevice),
    // so there's nothing to evict mid-traversal.
    const evictTrack = listContext[idx - QUEUE_WINDOW];
    if (evictTrack?.id != null) evictFromDeviceCache(evictTrack.id);
  }

  let nowPlayingMode = null; // 'playlist' | 'album' | null

  // Playlist search uses the same player queue as the iPod Queue screen.
  // This keeps search results ephemeral: they become the playback queue without
  // modifying the persisted playlist.
  window.__setPlaylistSearchQueue = (tracks) => {
    const queue = Array.isArray(tracks) ? tracks.filter(t => t && (t.id != null || t.track_id != null)) : [];
    if (!queue.length) return;
    playTrack(queue[0], queue, "playlist");
    toast(`${queue.length} search result${queue.length === 1 ? "" : "s"} queued`);
  };

  function playTrack(track, listContext, mode = null) {
    nowPlayingTrack = track;
    nowPlayingList = listContext;
    nowPlayingMode = mode;
    overrideState = null;
    const id = track.id ?? track.track_id;
    pendingTrackId = id;
    pollGeneration++;
    attemptPlayback(id);
    pruneQueueWindow(track, listContext, mode);
    if (current()?.key !== "nowplaying") push(nowPlayingScreen());
    else renderNowPlaying();
  }

  function attemptPlayback(id) {
    setNpState("Loading…");
    audio.src = `${API}/playback/${encodeURIComponent(id)}`;
    audio.play().catch(() => {});
    if (nowPlayingMode === "playlist") prefetchNext();
  }

  function pollJobSilently(jobId, attempt = 0) {
    return new Promise((resolve) => {
      if (attempt > 90) { resolve(false); return; }
      setTimeout(async () => {
        try {
          const job = await getJob(jobId);
          if (job.status === "complete") resolve(true);
          else if (job.status === "failed") resolve(false);
          else resolve(await pollJobSilently(jobId, attempt + 1));
        } catch { resolve(false); }
      }, 4000);
    });
  }

  async function warmOnDeviceCache(trackId) {
    try {
      await fetch(`${API}/playback/${encodeURIComponent(trackId)}`, {
        credentials: "include",
        headers: { Range: "bytes=0-0", "X-Cache-Warm": "1" },
      });
    } catch { /* best effort */ }
  }

  async function prefetchNext() {
    const n = neighborTrack(1);
    if (!n || n.id == null) return;
    // Runs entirely in the background -- the caller doesn't await this, so
    // it never blocks the track that's actually playing right now. Ensure
    // acquisition has actually finished before pinging for cache warm;
    // pinging immediately (in parallel with acquisition) would almost
    // always hit a 409 before the download can finish minutes later, and
    // nothing would ever retry it -- so the on-device cache never
    // actually got warmed through this path.
    try {
      const res = await acquireTrack(n.id);
      if (res.cached) { warmOnDeviceCache(n.id); return; }
      if (res.job_id) {
        const ok = await pollJobSilently(res.job_id);
        if (ok) warmOnDeviceCache(n.id);
      }
    } catch { /* best effort */ }
  }

  audio.addEventListener("error", async () => {
    const id = pendingTrackId;
    if (id == null) return;
    try {
      const res = await fetch(`${API}/playback/${encodeURIComponent(id)}`, { credentials: "include" });
      if (res.status === 409) {
        beginAcquisition(id);
      } else if (!res.ok) {
        let msg = `Playback failed (${res.status})`;
        try { const body = await res.json(); if (body.error) msg = body.error; } catch { /* ignore */ }
        setNpState(msg);
      }
    } catch { setNpState("Playback failed"); }
  });

  async function beginAcquisition(id) {
    setNpState("Preparing to download…");
    const myGen = pollGeneration;
    try {
      const res = await acquireTrack(id);
      if (myGen !== pollGeneration) return; // superseded by a newer track selection
      if (res.cached) { attemptPlayback(id); return; }
      pollJob(res.job_id, id, 0, myGen);
    } catch (e) { setNpState(e.message); }
  }

  function pollJob(jobId, trackId, attempt, myGen) {
    if (myGen !== pollGeneration) return;
    if (attempt > 90) { setNpState("Taking longer than expected — try again later"); return; }
    setNpState("Downloading… this can take a minute");
    setTimeout(async () => {
      if (myGen !== pollGeneration) return;
      try {
        const job = await getJob(jobId);
        if (myGen !== pollGeneration) return;
        if (job.status === "complete") { setNpState("Ready"); attemptPlayback(trackId); }
        else if (job.status === "failed") { setNpState("Download failed: " + (job.error || "unknown error")); }
        else pollJob(jobId, trackId, attempt + 1, myGen);
      } catch (e) { setNpState(e.message); }
    }, 4000);
  }

  function renderNowPlaying() {
    const t = nowPlayingTrack;
    document.getElementById("npTitle").textContent = t ? (t.title || "Untitled") : "Nothing playing";
    document.getElementById("npSub").textContent = t ? [t.artist, t.album].filter(Boolean).join(" — ") : "—";
    const art = document.getElementById("npArt");
    if (t?.artwork_url) art.innerHTML = `<img src="${esc(t.artwork_url)}" alt="">`;
    else art.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    updateProgress();
    renderNowPlayingStateOnly();
  }

  function renderNowPlayingStateOnly() {
    document.getElementById("npState").textContent = overrideState || (audio.paused ? "Paused" : "Playing");
  }

  function updateProgress() {
    const dur = audio.duration || 0, cur = audio.currentTime || 0;
    document.getElementById("npFill").style.width = dur ? `${(cur / dur) * 100}%` : "0%";
    document.getElementById("npCur").textContent = fmtTime(cur);
    document.getElementById("npDur").textContent = fmtTime(dur);
  }

  function togglePlay() {
    if (!audio.src) return;
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    renderNowPlayingStateOnly();
    refreshQueueHeaderIfVisible();
  }

  function neighborTrack(delta) {
    if (!nowPlayingList || !nowPlayingTrack) return null;
    const idx = nowPlayingList.findIndex(t => t.id === nowPlayingTrack.id);
    if (idx === -1) return null;
    return nowPlayingList[idx + delta] || null;
  }

  function skip(delta) {
    const n = neighborTrack(delta);
    if (n) playTrack(n, nowPlayingList, nowPlayingMode);
    else if (delta < 0) audio.currentTime = 0;
  }

  audio.addEventListener("timeupdate", () => { updateProgress(); });
  audio.addEventListener("loadedmetadata", updateProgress);
  audio.addEventListener("playing", () => { overrideState = null; renderNowPlayingStateOnly(); refreshQueueHeaderIfVisible(); });
  audio.addEventListener("pause", () => { if (!overrideState) { renderNowPlayingStateOnly(); refreshQueueHeaderIfVisible(); } });
  audio.addEventListener("ended", () => { if (neighborTrack(1)) skip(1); });

  /* ---------- wheel + buttons ---------- */

  const btnMenu = document.getElementById("btnMenu");
  const btnPrev = document.getElementById("btnPrev");
  const btnNext = document.getElementById("btnNext");
  const btnPlay = document.getElementById("btnPlay");
  const btnCenter = document.getElementById("btnCenter");
  const wheel = document.getElementById("wheel");
  const volOverlay = document.getElementById("volOverlay");
  const volFill = document.getElementById("volFill");

  let volTimer = null;
  function showVolume() {
    volFill.style.width = `${Math.round(audio.volume * 100)}%`;
    volOverlay.classList.add("show");
    clearTimeout(volTimer);
    volTimer = setTimeout(() => volOverlay.classList.remove("show"), 1200);
  }

  function onMenuBtn() { pop(); }
  function onPrevBtn() { if (current()?.kind === "nowplaying") skip(-1); else moveSelection(-1); }
  function onNextBtn() { if (current()?.kind === "nowplaying") skip(1); else moveSelection(1); }
  function onPlayBtn() { if (current()?.kind === "nowplaying") togglePlay(); else if (nowPlayingTrack) push(nowPlayingScreen()); }

  btnMenu.addEventListener("click", onMenuBtn);
  btnPrev.addEventListener("click", onPrevBtn);
  btnNext.addEventListener("click", onNextBtn);
  btnPlay.addEventListener("click", onPlayBtn);
  btnCenter.addEventListener("click", selectCurrent);

  // Wheel divided into 8 equal 45-degree sections (a-h) around its center.
  // Moving from one section into an adjacent one within SECTION_TIMEOUT_MS
  // counts as a single scroll tick in that direction. The gesture can
  // start in any section -- only the transition between sections matters,
  // not an absolute starting point.
  const SECTION_COUNT = 8;
  const SECTION_TIMEOUT_MS = 500;
  let dragging = false, lastSection = null, lastSectionTime = 0;

  function sectionFromEvent(e) {
    const r = wheel.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const p = e.touches ? e.touches[0] : e;
    let deg = Math.atan2(p.clientY - cy, p.clientX - cx) * (180 / Math.PI);
    deg = (deg + 360) % 360;
    return Math.floor(deg / (360 / SECTION_COUNT)) % SECTION_COUNT;
  }

  function wheelStart(e) {
    if (e.target.closest(".zone") || e.target.closest(".center-btn")) return;
    dragging = true;
    lastSection = sectionFromEvent(e);
    lastSectionTime = performance.now();
  }
  function wheelMove(e) {
    if (!dragging) return;
    const section = sectionFromEvent(e);
    const now = performance.now();

    if (section !== lastSection) {
      const elapsed = now - lastSectionTime;

      if (elapsed <= SECTION_TIMEOUT_MS) {
        // Shortest signed distance around the 8 sections (clockwise positive).
        let delta = section - lastSection;
        if (delta > SECTION_COUNT / 2) delta -= SECTION_COUNT;
        if (delta < -SECTION_COUNT / 2) delta += SECTION_COUNT;

        if (delta !== 0) {
          if (current()?.kind === "nowplaying") {
            if (delta > 0) { audio.volume = Math.min(1, audio.volume + 0.05 * Math.abs(delta)); }
            else { audio.volume = Math.max(0, audio.volume - 0.05 * Math.abs(delta)); }
            showVolume();
          } else {
            moveSelection(delta);
          }
        }
      }

      lastSection = section;
      lastSectionTime = now;
    }
    e.preventDefault();
  }
  function wheelEnd() { dragging = false; lastSection = null; }

  wheel.addEventListener("mousedown", wheelStart);
  window.addEventListener("mousemove", wheelMove);
  window.addEventListener("mouseup", wheelEnd);
  wheel.addEventListener("touchstart", wheelStart, { passive: true });
  window.addEventListener("touchmove", wheelMove, { passive: false });
  window.addEventListener("touchend", wheelEnd);

  window.addEventListener("keydown", (e) => {
    if (document.activeElement && ["INPUT"].includes(document.activeElement.tagName)) {
      if (e.key === "Enter") { e.preventDefault(); selectCurrent(); }
      return;
    }
    if (e.key === "ArrowUp") { moveSelection(-1); e.preventDefault(); }
    else if (e.key === "ArrowDown") { moveSelection(1); e.preventDefault(); }
    else if (e.key === "Enter") { selectCurrent(); e.preventDefault(); }
    else if (e.key === "Escape" || e.key === "Backspace") { pop(); e.preventDefault(); }
  });

  document.getElementById("searchGo").addEventListener("click", runSearch);
  document.getElementById("albumGo").addEventListener("click", runAlbumSearch);
  document.getElementById("appleGo").addEventListener("click", runAppleImport);
  document.getElementById("clearAllGo").addEventListener("click", runClearAllData);

  /* ---------- login ---------- */

  document.getElementById("loginBtn").addEventListener("click", doLogin);
  document.getElementById("password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

  async function doLogin() {
    const pw = document.getElementById("password").value;
    const err = document.getElementById("loginErr");
    err.textContent = "";
    try {
      await login(pw);
      loginWrap.classList.add("hidden");
      statusbar.style.display = "flex";
      openHome();
    } catch (e) { err.textContent = e.message; }
  }

  /* ---------- CSV library seed / Excel export ---------- */

  function parseLibraryCsv(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], n = text[i + 1];
      if (c === '"') {
        if (quoted && n === '"') { cell += '"'; i++; }
        else quoted = !quoted;
      } else if (c === "," && !quoted) {
        row.push(cell); cell = "";
      } else if ((c === "\n" || c === "\r") && !quoted) {
        if (c === "\r" && n === "\n") i++;
        row.push(cell); cell = "";
        if (row.some(v => v.trim() !== "")) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some(v => v.trim() !== "")) rows.push(row);
    if (!rows.length) return [];
    const headers = rows[0].map(h => h.trim());
    return rows.slice(1).map(values => Object.fromEntries(headers.map((h, i) => [h, (values[i] || "").trim()])));
  }

  async function openLibraryCsvImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        toast("Reading library CSV…", 4000);
        const rows = parseLibraryCsv(await file.text());
        const items = rows.filter(r => r["Track name"]).map(r => ({
          title: r["Track name"],
          artist: r["Artist name"] || "",
          album: r["Album"] || "",
          playlist_name: r["Playlist name"] || "Playlist",
          type: r["Type"] || "Playlist",
          isrc: r["ISRC"] || "",
          source_id: r["Apple - id"] || "",
          apple_id: r["Apple - id"] || "",
          cache: String(r["100 Cache"] || "").toUpperCase() === "Y",
          playCount: 0,
          play_count: 0,
        }));
        if (!items.length) throw new Error("No tracks found in CSV");
        const playlistName = items[0].playlist_name || "Playlist";
        await appleMusicImport(items);
        const seeded = await api("/library/seed", {
          method: "POST",
          body: JSON.stringify({ playlist_name: playlistName, items }),
        });
        toast(`Imported ${seeded.playlist_entries} tracks; ${seeded.cache_entries} cached`, 5000);
        await openPlaylist();
      } catch (e) {
        toast(`Library import failed: ${e.message}`, 6000);
      }
    };
    input.click();
  }

  function exportPlaylistExcel() {
    window.location.href = API + "/playlist/export";
  }

})();

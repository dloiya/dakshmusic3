(() => {
  const API = "/api/v1";

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
  const searchAlbums = (q) => api("/albums/search?q=" + encodeURIComponent(q));
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
    if (sel) sel.scrollIntoView({ block: "nearest" });
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
        { label: "Clear Playlist", action: async () => {
            if (!confirm("Clear the entire playlist? Cached audio is kept.")) return;
            try { await clearPlaylist(); toast("Playlist cleared"); } catch (e) { toast(e.message); }
          } },
        { label: "Log Out", action: async () => { await logout(); location.reload(); } },
      ],
    });
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
      s.items = rows.map((t, i) => ({ html: playlistRowHtml(t, i, rows.length), action: () => playTrack(t, rows) }));
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
      const rows = await getPlaylist();
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
        upNext.forEach(t => items.push({ label: t.title || "Untitled", sub: t.artist || "", action: () => playTrack(t, rows) }));
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
        action: async () => { try { await addToPlaylist(it); toast("Added to Playlist"); } catch (e) { toast(e.message); } },
      }));
      push(s);
    } catch (e) { status.textContent = e.message; }
  }

  /* ---------- albums ---------- */

  function openAlbums() {
    push({ key: "albums", title: "Albums", kind: "field", onGo: runAlbumSearch });
    setTimeout(() => document.getElementById("albumInput").focus(), 50);
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
      const tracks = al.tracks || [];
      const items = [{
        label: "▸ Play Album", sub: `${tracks.length} track(s)`,
        action: async () => {
          if (!tracks.length) return;
          toast("Adding album to Playlist…");
          for (const t of tracks) { try { await addToPlaylist(t); } catch { /* keep going */ } }
          const rows = await getPlaylist();
          playlistCache = rows;
          const first = rows.find(r => r.source_id === tracks[0].source_id);
          if (first) playTrack(first, rows);
        },
      }];
      tracks.forEach(t => items.push({
        label: t.title || "Untitled", sub: fmtTime((t.duration_ms || 0) / 1000),
        action: async () => {
          try {
            await addToPlaylist(t);
            const rows = await getPlaylist();
            playlistCache = rows;
            const added = rows.find(r => r.source_id === t.source_id);
            if (added) playTrack(added, rows);
          } catch (e) { toast(e.message); }
        },
      }));
      s.items = items;
      if (!tracks.length) s.emptyText = "No tracks in this album.";
    } catch (e) { s.emptyText = e.message; s.items = []; }
    renderMenu(s);
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

  function playTrack(track, listContext) {
    nowPlayingTrack = track;
    nowPlayingList = listContext;
    overrideState = null;
    const id = track.id ?? track.track_id;
    pendingTrackId = id;
    pollGeneration++;
    attemptPlayback(id);
    if (current()?.key !== "nowplaying") push(nowPlayingScreen());
    else renderNowPlaying();
  }

  function attemptPlayback(id) {
    setNpState("Loading…");
    audio.src = `${API}/playback/${encodeURIComponent(id)}`;
    audio.play().catch(() => {});
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
    if (n) playTrack(n, nowPlayingList);
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

  let dragging = false, lastAngle = 0, accum = 0;
  const TICK_DEG = 20;

  function angleFromEvent(e) {
    const r = wheel.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const p = e.touches ? e.touches[0] : e;
    return Math.atan2(p.clientY - cy, p.clientX - cx) * (180 / Math.PI);
  }

  function wheelStart(e) {
    if (e.target.closest(".zone") || e.target.closest(".center-btn")) return;
    dragging = true; accum = 0;
    lastAngle = angleFromEvent(e);
  }
  function wheelMove(e) {
    if (!dragging) return;
    const a = angleFromEvent(e);
    let diff = a - lastAngle;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    lastAngle = a;
    accum += diff;
    while (accum >= TICK_DEG) {
      accum -= TICK_DEG;
      if (current()?.kind === "nowplaying") { audio.volume = Math.min(1, audio.volume + 0.05); showVolume(); }
      else moveSelection(1);
    }
    while (accum <= -TICK_DEG) {
      accum += TICK_DEG;
      if (current()?.kind === "nowplaying") { audio.volume = Math.max(0, audio.volume - 0.05); showVolume(); }
      else moveSelection(-1);
    }
    e.preventDefault();
  }
  function wheelEnd() { dragging = false; }

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
})();

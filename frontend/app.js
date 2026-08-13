(() => {
  const API = "/api/v1";

  /* ---------- low-level API helpers (unchanged real endpoints) ---------- */

  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      credentials: "include",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const login = (password) => api("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
  const logout = () => api("/auth/logout", { method: "POST" }).catch(() => {});
  const search = (q) => api("/search?q=" + encodeURIComponent(q));
  const getPlaylist = () => api("/playlist");
  const addToPlaylist = (item) => api("/playlist", { method: "POST", body: JSON.stringify(item) });
  const removeFromPlaylist = (entryId) => api("/playlist/" + encodeURIComponent(entryId), { method: "DELETE" });
  const clearPlaylist = () => api("/playlist", { method: "DELETE" });
  const getTop100 = () => api("/cache/top");
  const appleMusicImport = (items) => api("/apple-music/import", { method: "POST", body: JSON.stringify({ items }) });

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
  function toast(msg, ms = 1600) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  /* ---------- navigation stack ---------- */

  const views = {};
  document.querySelectorAll(".view").forEach(v => { views[v.id.replace("view-", "")] = v; });

  let stack = [];       // [{key, title, items, selected, kind, custom...}]
  let playlistCache = []; // last loaded playlist, used for now-playing prev/next

  function showView(key) {
    Object.values(views).forEach(v => v.classList.remove("active"));
    if (views[key]) views[key].classList.add("active");
  }

  function current() { return stack[stack.length - 1]; }

  function push(screen) {
    stack.push(screen);
    renderCurrent();
  }

  function replaceTop(screen) {
    stack[stack.length - 1] = screen;
    renderCurrent();
  }

  function pop() {
    if (stack.length <= 1) return;
    stack.pop();
    renderCurrent();
  }

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
      listEl.innerHTML = `<li class="empty" style="display:block;border:none;padding-top:40px">${esc(s.emptyText || "Nothing here yet")}</li>`;
      return;
    }
    listEl.innerHTML = s.items.map((it, i) => `
      <li data-i="${i}" class="${i === s.selected ? "sel" : ""}">
        <div class="l">
          ${it.dot ? `<span class="dot ${it.dot}"></span>` : ""}
          <span class="name">${esc(it.label)}</span>
        </div>
        ${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : `<span class="chev">${it.chev || (it.action ? "▸" : "")}</span>`}
      </li>
    `).join("");
    const sel = listEl.querySelector("li.sel");
    if (sel) sel.scrollIntoView({ block: "nearest" });
    listEl.querySelectorAll("li[data-i]").forEach(li => {
      li.addEventListener("click", () => {
        s.selected = Number(li.dataset.i);
        renderMenu(s);
        selectCurrent();
      });
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

  /* ---------- menu screens ---------- */

  function openHome() {
    stack = [{
      key: "home", title: "daksh music", kind: "menu", selected: 0,
      items: [
        { label: "Music", action: openMusic },
        { label: "Extras", action: openExtras },
        { label: "Settings", action: openSettings },
      ],
    }];
    renderCurrent();
  }

  function openMusic() {
    push({
      key: "music", title: "Music", kind: "menu", selected: 0,
      items: [
        { label: "Now Playing", action: () => push(nowPlayingScreen()) },
        { label: "Playlist", action: openPlaylist },
        { label: "Search", action: openSearch },
        { label: "Top 100", action: openTop100 },
      ],
    });
  }

  function openExtras() {
    push({
      key: "extras", title: "Extras", kind: "menu", selected: 0,
      items: [
        { label: "Import Apple Music", action: openAppleImport },
      ],
    });
  }

  function openSettings() {
    push({
      key: "settings", title: "Settings", kind: "menu", selected: 0,
      items: [
        { label: "Clear Playlist", action: async () => {
            if (!confirm("Clear the entire playlist? Cached audio is kept.")) return;
            try { await clearPlaylist(); toast("Playlist cleared"); } catch (e) { toast(e.message); }
          } },
        { label: "Log Out", action: async () => { await logout(); location.reload(); } },
      ],
    });
  }

  async function openPlaylist() {
    const s = { key: "playlist", title: "Playlist", kind: "menu", selected: 0, items: [], emptyText: "Playlist is empty.\nAdd songs from Search." };
    push(s);
    try {
      const rows = await getPlaylist();
      playlistCache = rows;
      s.items = rows.map(t => ({
        label: t.title || "Untitled", sub: t.artist || "", action: () => playTrack(t, rows),
      }));
    } catch (e) { s.emptyText = e.message; }
    renderMenu(s);
  }

  async function openTop100() {
    const s = { key: "top100", title: "Top 100", kind: "menu", selected: 0, items: [], emptyText: "No play-count data yet.\nImport Apple Music from Extras." };
    push(s);
    try {
      const d = await getTop100();
      s.items = (d.items || []).map(t => ({
        label: `${t.rank}. ${t.title || "Untitled"}`,
        sub: t.artist || "",
        dot: t.storage_key ? "ready" : "pending",
        action: () => {
          if (!t.storage_key) { toast("Not downloaded yet"); return; }
          playTrack(t, null);
        },
      }));
    } catch (e) { s.emptyText = e.message; }
    renderMenu(s);
  }

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
      const d = await search(q);
      status.textContent = "";
      const s = { key: "searchresults", title: "Results", kind: "menu", selected: 0, items: [], emptyText: "No results." };
      s.items = (d.items || []).map(it => ({
        label: it.title || "Untitled", sub: it.artist || "",
        action: async () => {
          try { await addToPlaylist(it); toast("Added to Playlist"); }
          catch (e) { toast(e.message); }
        },
      }));
      push(s);
    } catch (e) { status.textContent = e.message; }
  }

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

  /* ---------- now playing ---------- */

  let nowPlayingTrack = null;
  let nowPlayingList = null; // playlist array for prev/next, or null

  function nowPlayingScreen() {
    return { key: "nowplaying", title: "Now Playing", kind: "nowplaying" };
  }

  function playTrack(track, listContext) {
    nowPlayingTrack = track;
    nowPlayingList = listContext;
    const id = track.id ?? track.track_id;
    audio.src = `${API}/playback/${encodeURIComponent(id)}`;
    audio.play().catch(() => toast("Not ready yet — try again shortly"));
    if (current()?.key !== "nowplaying") push(nowPlayingScreen());
    else renderNowPlaying();
  }

  function renderNowPlaying() {
    const t = nowPlayingTrack;
    document.getElementById("npTitle").textContent = t ? (t.title || "Untitled") : "Nothing playing";
    document.getElementById("npSub").textContent = t ? [t.artist, t.album].filter(Boolean).join(" — ") : "—";
    const art = document.getElementById("npArt");
    if (t?.artwork_url) art.innerHTML = `<img src="${esc(t.artwork_url)}" alt="">`;
    else art.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    updateProgress();
    updatePlayState();
  }

  function updateProgress() {
    const dur = audio.duration || 0, cur = audio.currentTime || 0;
    document.getElementById("npFill").style.width = dur ? `${(cur / dur) * 100}%` : "0%";
    document.getElementById("npCur").textContent = fmtTime(cur);
    document.getElementById("npDur").textContent = fmtTime(dur);
  }

  function updatePlayState() {
    document.getElementById("npState").textContent = audio.paused ? "Paused" : "Playing";
  }

  function togglePlay() {
    if (!audio.src) return;
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    updatePlayState();
  }

  function neighborTrack(delta) {
    if (!nowPlayingList || !nowPlayingTrack) return null;
    const idx = nowPlayingList.findIndex(t => (t.id ?? t.entry_id) === (nowPlayingTrack.id ?? nowPlayingTrack.entry_id));
    if (idx === -1) return null;
    return nowPlayingList[idx + delta] || null;
  }

  function skip(delta) {
    const n = neighborTrack(delta);
    if (n) playTrack(n, nowPlayingList);
    else if (delta < 0) { audio.currentTime = 0; }
  }

  audio.addEventListener("timeupdate", updateProgress);
  audio.addEventListener("loadedmetadata", updateProgress);
  audio.addEventListener("play", updatePlayState);
  audio.addEventListener("pause", updatePlayState);
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

  function onPrevBtn() {
    if (current()?.kind === "nowplaying") skip(-1);
    else moveSelection(-1);
  }
  function onNextBtn() {
    if (current()?.kind === "nowplaying") skip(1);
    else moveSelection(1);
  }
  function onPlayBtn() {
    if (current()?.kind === "nowplaying") togglePlay();
    else if (nowPlayingTrack) push(nowPlayingScreen());
  }

  btnMenu.addEventListener("click", onMenuBtn);
  btnPrev.addEventListener("click", onPrevBtn);
  btnNext.addEventListener("click", onNextBtn);
  btnPlay.addEventListener("click", onPlayBtn);
  btnCenter.addEventListener("click", selectCurrent);

  // circular drag -> discrete scroll ticks (mimics click-wheel detents)
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

  // keyboard support (accessibility / desktop convenience)
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

  /* ---------- field-screen go buttons (click, since they're not menu items) ---------- */

  document.getElementById("searchGo").addEventListener("click", runSearch);
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

  /* boot: assume logged out until proven otherwise */
})();

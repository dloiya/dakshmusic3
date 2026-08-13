(() => {
  const API = "/api/v1";
  const playlistView = document.getElementById("view-playlist");
  const playlistList = document.getElementById("list-playlist");
  const audio = document.getElementById("audio");
  const center = document.getElementById("btnCenter");
  const next = document.getElementById("btnNext");
  const prev = document.getElementById("btnPrev");
  if (!playlistView || !playlistList || !audio) return;

  const esc = v => String(v ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#039;"}[c]));
  let rows = [];
  let query = "";
  let selected = 0;
  let searchQueue = [];
  let queueIndex = -1;

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search song, artist, album…";
  search.autocomplete = "off";
  search.setAttribute("aria-label", "Search playlist");
  search.className = "playlist-search";
  playlistView.insertBefore(search, playlistList);

  const status = document.createElement("div");
  status.className = "playlist-search-status";
  playlistView.insertBefore(status, playlistList);

  function filtered() {
    const q = query.trim().toLowerCase();
    return q ? rows.filter(t => [t.title,t.artist,t.album,t.isrc,t.source,t.source_id]
      .some(v => String(v || "").toLowerCase().includes(q))) : rows;
  }

  function render() {
    const list = filtered();
    if (selected >= list.length) selected = Math.max(0, list.length - 1);
    status.textContent = query ? `${list.length} result${list.length === 1 ? "" : "s"}` : `${rows.length} tracks`;
    playlistList.innerHTML = list.length ? list.map((t, i) => `
      <li data-play-index="${i}" class="${i === selected ? "sel" : ""}">
        <div class="l"><span class="name">${esc(t.title || "Untitled")}</span></div>
        <span class="sub">${esc(t.artist || "")}${t.album ? ` · ${esc(t.album)}` : ""}</span>
      </li>`).join("") : `<li class="empty">No matching tracks.</li>`;
    playlistList.querySelectorAll("[data-play-index]").forEach(li => {
      li.addEventListener("click", () => { selected = Number(li.dataset.playIndex); render(); });
    });
  }

  async function loadPlaylist() {
    try {
      const r = await fetch(`${API}/playlist`, { credentials: "include" });
      if (!r.ok) return;
      const data = await r.json();
      rows = Array.isArray(data) ? data : (data.items || data.results || []);
      render();
    } catch {}
  }

  function showPlayer() {
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    const nowPlaying = document.getElementById("view-nowplaying");
    if (nowPlaying) nowPlaying.classList.add("active");
  }

  async function startSearchQueue() {
    const list = filtered();
    if (!list.length) return;

    if (searchQueue.length || audio.src) {
      const clear = confirm("Clear the current queue and play the search results?\n\nOK = clear queue\nCancel = append search results");
      if (clear) searchQueue = [];
    }

    searchQueue.push(...list);
    queueIndex = searchQueue.length - list.length + selected;

    if (window.__playSearchQueue) {
      window.__playSearchQueue(searchQueue, queueIndex);
    } else {
      const track = searchQueue[queueIndex];
      if (track?.id != null) {
        audio.src = `${API}/playback/${encodeURIComponent(track.id)}`;
        audio.play().catch(() => {});
      }
    }
    showPlayer();
  }

  center?.addEventListener("click", e => {
    if (document.getElementById("view-playlist")?.classList.contains("active") && query.trim()) {
      e.stopImmediatePropagation();
      startSearchQueue();
    }
  }, true);

  next?.addEventListener("click", e => {
    if (searchQueue.length && document.getElementById("view-nowplaying")?.classList.contains("active")) {
      e.stopImmediatePropagation();
      if (queueIndex < searchQueue.length - 1) {
        queueIndex++;
        if (window.__playSearchQueue) window.__playSearchQueue(searchQueue, queueIndex);
      }
    }
  }, true);

  prev?.addEventListener("click", e => {
    if (searchQueue.length && document.getElementById("view-nowplaying")?.classList.contains("active")) {
      e.stopImmediatePropagation();
      if (queueIndex > 0) {
        queueIndex--;
        if (window.__playSearchQueue) window.__playSearchQueue(searchQueue, queueIndex);
      }
    }
  }, true);

  audio.addEventListener("ended", () => {
    if (searchQueue.length && queueIndex < searchQueue.length - 1) {
      queueIndex++;
      if (window.__playSearchQueue) window.__playSearchQueue(searchQueue, queueIndex);
    }
  });

  search.addEventListener("input", () => { query = search.value; selected = 0; render(); });
  search.addEventListener("keydown", e => {
    if (e.key === "Escape") { search.value = ""; query = ""; selected = 0; render(); }
  });

  const footer = document.createElement("footer");
  footer.className = "app-footer";
  footer.innerHTML = `
    <div id="acquisitionPanel" class="acquisition-panel">
      <button type="button" id="acquisitionToggle" aria-expanded="false">Acquisition status <span>▸</span></button>
      <div id="acquisitionBody" hidden><div class="acq-empty">No acquisition activity.</div></div>
    </div>`;
  document.querySelector(".device")?.appendChild(footer);

  document.getElementById("acquisitionToggle")?.addEventListener("click", () => {
    const body = document.getElementById("acquisitionBody");
    const button = document.getElementById("acquisitionToggle");
    const open = body.hidden;
    body.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.querySelector("span").textContent = open ? "▾" : "▸";
    if (open) refreshJobs();
  });

  async function refreshJobs() {
    const body = document.getElementById("acquisitionBody");
    if (!body || body.hidden) return;
    try {
      const r = await fetch(`${API}/jobs/status`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const jobs = data.jobs || [];
      body.innerHTML = jobs.length ? jobs.map(j => `
        <div class="acq-row ${j.status === "failed" ? "failed" : ""}">
          <div><strong>${esc(j.title || "Unknown track")}</strong><small>${esc(j.artist || "")}</small></div>
          <span>${esc(j.status || "unknown")}</span>
          ${j.error ? `<div class="acq-error">${esc(j.error)}</div>` : ""}
        </div>`).join("") : `<div class="acq-empty">No acquisition activity.</div>`;
    } catch (e) {
      body.innerHTML = `<div class="acq-error">Unable to load acquisition status: ${esc(e.message)}</div>`;
    }
  }

  function injectStyle() {
    const s = document.createElement("style");
    s.textContent = `
      .playlist-search{margin:5px 8px 2px;width:calc(100% - 16px);padding:6px 8px;border:1px solid #b9bdb8;border-radius:5px;background:#fff;color:var(--screen-ink);font:inherit;font-size:11px;outline:none}
      .playlist-search:focus{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
      .playlist-search-status{font-size:9px;color:var(--screen-sub);padding:1px 9px 3px}
      .app-footer{width:100%;margin-top:10px;padding-top:6px;border-top:1px solid rgba(0,0,0,.08)}
      .acquisition-panel{width:100%;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}
      #acquisitionToggle{width:100%;border:1px solid #cfcdc7;border-radius:6px;background:#e9e7e2;color:#5b625d;padding:5px 8px;text-align:left;font:600 10px inherit;cursor:pointer}
      #acquisitionBody{margin-top:4px;background:#f2f1ee;border:1px solid #cfcdc7;border-radius:6px;padding:5px;max-height:140px;overflow:auto}
      .menu li.sel{background:linear-gradient(180deg,var(--sel-a),var(--sel-b));color:var(--sel-ink)}
      .menu li.sel .sub{color:#dbe6f5}
      .acq-row{position:relative;padding:5px 4px;border-bottom:1px solid rgba(0,0,0,.07);font-size:9.5px;color:#1b1f1c}.acq-row:last-child{border-bottom:0}.acq-row strong{display:block}.acq-row small{display:block;color:#5b625d;margin-top:1px}.acq-row>span{position:absolute;right:4px;top:6px;font-size:8.5px;color:#5b625d}.acq-row.failed>span{color:#b34c3c}.acq-error{margin-top:4px;color:#b34c3c;white-space:pre-wrap;word-break:break-word}.acq-empty{padding:7px;text-align:center;color:#5b625d;font-size:9px}
    `;
    document.head.appendChild(s);
  }

  injectStyle();
  loadPlaylist();
  setInterval(() => { loadPlaylist(); refreshJobs(); }, 5000);
})();
(() => {
  const API = "/api/v1";
  const playlistView = document.getElementById("view-playlist");
  const playlistList = document.getElementById("list-playlist");
  const audio = document.getElementById("audio");
  if (!playlistView || !playlistList || !audio) return;

  const esc = v => String(v ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#039;"}[c]));
  let rows = [];
  let query = "";
  let timer = null;

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

  const panel = document.createElement("div");
  panel.id = "acquisitionPanel";
  panel.innerHTML = `
    <button type="button" id="acquisitionToggle" aria-expanded="false">Acquisition status <span>▸</span></button>
    <div id="acquisitionBody" hidden><div class="acq-empty">No acquisition activity.</div></div>`;
  document.querySelector(".device")?.insertAdjacentElement("afterend", panel);

  function filtered() {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(t => [t.title,t.artist,t.album,t.isrc,t.source,t.source_id].some(v => String(v || "").toLowerCase().includes(q)));
  }

  function play(t) {
    if (!t?.id && !t?.track_id) return;
    const id = t.id ?? t.track_id;
    audio.src = `${API}/playback/${encodeURIComponent(id)}`;
    audio.play().catch(() => {});
    const title = document.getElementById("screenTitle");
    if (title) title.textContent = t.title || "Now Playing";
  }

  function render() {
    const list = filtered();
    status.textContent = query ? `${list.length} result${list.length === 1 ? "" : "s"}` : `${rows.length} tracks`;
    playlistList.innerHTML = list.length ? list.map((t, i) => `
      <li data-play-index="${i}">
        <div class="l"><span class="name">${esc(t.title || "Untitled")}</span></div>
        <span class="sub">${esc(t.artist || "")}${t.album ? ` · ${esc(t.album)}` : ""}</span>
      </li>`).join("") : `<li class="empty">No matching tracks.</li>`;
    playlistList.querySelectorAll("[data-play-index]").forEach(li => {
      li.addEventListener("click", () => play(list[Number(li.dataset.playIndex)]));
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

  search.addEventListener("input", () => { query = search.value; render(); });
  search.addEventListener("keydown", e => {
    if (e.key === "Escape") { search.value = ""; query = ""; render(); }
  });

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
      #acquisitionPanel{width:300px;margin:10px auto 0;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}
      #acquisitionToggle{width:100%;border:1px solid #cfcdc7;border-radius:8px;background:#f2f1ee;color:#5b625d;padding:7px 9px;text-align:left;font:600 11px inherit;cursor:pointer;box-shadow:0 2px 5px rgba(0,0,0,.12)}
      #acquisitionBody{margin-top:4px;background:#f2f1ee;border:1px solid #cfcdc7;border-radius:8px;padding:6px;max-height:180px;overflow:auto;box-shadow:0 2px 5px rgba(0,0,0,.12)}
      .acq-row{position:relative;padding:6px 5px;border-bottom:1px solid rgba(0,0,0,.07);font-size:10px;color:#1b1f1c}.acq-row:last-child{border-bottom:0}.acq-row strong{display:block}.acq-row small{display:block;color:#5b625d;margin-top:1px}.acq-row>span{position:absolute;right:5px;top:7px;font-size:9px;color:#5b625d}.acq-row.failed>span{color:#b34c3c}.acq-error{margin-top:4px;color:#b34c3c;white-space:pre-wrap;word-break:break-word}.acq-empty{padding:8px;text-align:center;color:#5b625d;font-size:10px}
    `;
    document.head.appendChild(s);
  }

  injectStyle();
  loadPlaylist();
  setInterval(() => { loadPlaylist(); refreshJobs(); }, 5000);
})();

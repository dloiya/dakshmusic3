from pathlib import Path

p = Path('frontend/app.js')
s = p.read_text()
if 'playlistSearchState' in s:
    raise SystemExit('UI patch already applied')
marker = '  /* ---------- queue (now playing + up next) ---------- */'
insert = r'''  /* ---------- playlist search + acquisition status ---------- */

  let playlistSearchState = { query: "", rows: [] };
  let acquisitionTimer = null;

  function playlistMatches(rows, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(t => [t.title, t.artist, t.album, t.isrc, t.source, t.source_id]
      .some(v => String(v || "").toLowerCase().includes(q)));
  }

  function playlistSearchHtml() {
    return `<div class="playlist-search-wrap" data-stop><input id="playlistSearchInput" class="playlist-search-input" type="search" placeholder="Search song, artist, album…" value="${esc(playlistSearchState.query)}" autocomplete="off" /></div>`;
  }

  function renderPlaylistSearch(s, rows) {
    const listEl = document.getElementById("list-playlist");
    if (!listEl) return;
    const filtered = playlistMatches(rows, playlistSearchState.query);
    playlistSearchState.rows = rows;
    const searchRow = `<li class="playlist-search-row" data-stop>${playlistSearchHtml()}</li>`;
    const body = filtered.length ? filtered.map(t => {
      const originalIndex = rows.indexOf(t);
      return `<li data-search-index="${originalIndex}" class="${originalIndex === s.selected ? "sel" : ""}"><div class="l"><span class="name">${esc(t.title || "Untitled")}</span></div><span class="sub">${esc([t.artist, t.album].filter(Boolean).join(" · "))}</span></li>`;
    }).join("") : `<li class="empty" style="display:block;border:none;padding-top:25px">No matching tracks</li>`;
    listEl.innerHTML = searchRow + body;
    const input = document.getElementById("playlistSearchInput");
    if (input) {
      input.addEventListener("input", () => { playlistSearchState.query = input.value; renderPlaylistSearch(s, rows); requestAnimationFrame(() => { const el = document.getElementById("playlistSearchInput"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }); });
      input.addEventListener("keydown", e => { if (e.key === "Escape") { playlistSearchState.query = ""; renderPlaylistSearch(s, rows); } });
    }
    listEl.querySelectorAll("li[data-search-index]").forEach(li => li.addEventListener("click", () => { const track = rows[Number(li.dataset.searchIndex)]; if (track) playTrack(track, rows, "playlist-search"); }));
  }

  async function refreshAcquisitionStatus() {
    const panel = document.getElementById("acquisitionPanel");
    if (!panel) return;
    try {
      const data = await api("/jobs/status");
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      const active = jobs.filter(j => ["queued", "dispatched", "running"].includes(j.status));
      const failed = jobs.filter(j => j.status === "failed");
      panel.querySelector(".acq-summary").textContent = active.length ? `Acquiring ${active.length} song${active.length === 1 ? "" : "s"}…` : failed.length ? `${failed.length} acquisition error${failed.length === 1 ? "" : "s"}` : "No active acquisitions";
      panel.querySelector(".acq-list").innerHTML = (active.concat(failed)).map(j => { const label = [j.title, j.artist].filter(Boolean).join(" — ") || `Track ${j.track_id}`; const state = j.status === "failed" ? `Error: ${j.error || "Unknown error"}` : j.status; return `<div class="acq-item"><span class="acq-dot ${j.status === "failed" ? "error" : j.status}"></span><div><div class="acq-name">${esc(label)}</div><div class="acq-state">${esc(state)}</div></div></div>`; }).join("") || `<div class="acq-empty">Nothing is being acquired.</div>`;
    } catch (e) { panel.querySelector(".acq-summary").textContent = "Acquisition status unavailable"; panel.querySelector(".acq-list").innerHTML = `<div class="acq-empty">${esc(e.message)}</div>`; }
  }

  function installLibraryUi() {
    if (!document.getElementById("libraryUiStyles")) {
      const style = document.createElement("style"); style.id = "libraryUiStyles";
      style.textContent = `.playlist-search-row{padding:4px 7px!important;background:rgba(0,0,0,.035);position:sticky;top:0;z-index:2}.playlist-search-wrap{width:100%}.playlist-search-input{width:100%;border:1px solid #aeb5af;border-radius:5px;padding:6px 8px;font:inherit;font-size:11px;background:#fff;color:var(--screen-ink);outline:none}.playlist-search-input:focus{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.acquisition-panel{width:300px;margin-top:12px;border:1px solid rgba(255,255,255,.16);border-radius:12px;background:rgba(25,27,29,.88);color:#eee;overflow:hidden;box-shadow:0 10px 24px rgba(0,0,0,.24);font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}.acq-toggle{width:100%;border:0;background:transparent;color:inherit;padding:9px 11px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:11px;font-weight:700}.acq-summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.acq-chevron{transition:transform .15s ease}.acquisition-panel.open .acq-chevron{transform:rotate(180deg)}.acq-body{display:none;border-top:1px solid rgba(255,255,255,.1);max-height:180px;overflow:auto}.acquisition-panel.open .acq-body{display:block}.acq-item{display:flex;gap:8px;padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.07)}.acq-name{font-size:10.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:245px}.acq-state{font-size:9px;color:#aeb5b0;margin-top:2px}.acq-dot{width:7px;height:7px;border-radius:50%;margin-top:4px;flex:none;background:#c79a2b}.acq-dot.failed,.acq-dot.error{background:#c95849}.acq-dot.running{background:#4c9d61}.acq-empty{padding:10px;font-size:10px;color:#aeb5b0}`;
      document.head.appendChild(style);
    }
    if (!document.getElementById("acquisitionPanel")) {
      const panel = document.createElement("section"); panel.id = "acquisitionPanel"; panel.className = "acquisition-panel";
      panel.innerHTML = `<button class="acq-toggle" type="button"><span class="acq-summary">Checking acquisition status…</span><span class="acq-chevron">⌄</span></button><div class="acq-body"><div class="acq-list"></div></div>`;
      document.querySelector(".device")?.insertAdjacentElement("afterend", panel);
      panel.querySelector(".acq-toggle").addEventListener("click", () => panel.classList.toggle("open"));
    }
    refreshAcquisitionStatus(); clearInterval(acquisitionTimer); acquisitionTimer = setInterval(refreshAcquisitionStatus, 5000);
  }

  const originalOpenPlaylist = openPlaylist;
  openPlaylist = async function() { playlistSearchState.query = ""; await originalOpenPlaylist(); const s = current(); if (s?.key === "playlist") renderPlaylistSearch(s, playlistCache); };
  installLibraryUi();

'''
if marker not in s:
    raise SystemExit('marker not found')
p.write_text(s.replace(marker, insert + marker, 1))

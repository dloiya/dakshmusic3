(() => {
  const audio = document.getElementById("audio");
  const player = document.querySelector("#view-nowplaying .nowplaying");
  if (!audio || !player) return;

  const esc = v => String(v ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#039;"}[c]));
  const api = async (path, options = {}) => {
    const r = await fetch("/api/v1" + path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const text = await r.text(); let d = {};
    try { d = text ? JSON.parse(text) : {}; } catch {}
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };

  let actions = player.querySelector(".np-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "np-actions";
    actions.innerHTML = `
      <button type="button" id="npQueueIcon" title="Queue" aria-label="Queue">☷</button>
      <button type="button" id="npPlaylistIcon" title="Add to Playlist" aria-label="Add to Playlist">＋</button>
      <button type="button" id="npInfoIcon" title="Song Info" aria-label="Song Info">ⓘ</button>`;
    player.appendChild(actions);
  }

  const bar = player.querySelector(".np-bar");
  if (bar && !bar.dataset.interactive) {
    bar.dataset.interactive = "1";
    bar.id = "npBar";
    bar.setAttribute("role", "slider");
    bar.setAttribute("aria-label", "Track position");
    bar.tabIndex = 0;
    const seek = e => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      const r = bar.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audio.duration;
    };
    bar.addEventListener("pointerdown", e => { bar.setPointerCapture?.(e.pointerId); seek(e); });
    bar.addEventListener("pointermove", e => { if (e.buttons) seek(e); });
    bar.addEventListener("keydown", e => {
      if (!Number.isFinite(audio.duration)) return;
      if (e.key === "ArrowLeft") { audio.currentTime = Math.max(0, audio.currentTime - 5); e.preventDefault(); }
      if (e.key === "ArrowRight") { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); e.preventDefault(); }
    });
  }

  async function currentTrack() {
    if (window.__dakshNowPlayingTrack?.id != null) return window.__dakshNowPlayingTrack;
    const qs = window.__dakshQueue?.state;
    if (qs?.items?.[qs.current_index]) return qs.items[qs.current_index];
    const title = document.getElementById("npTitle")?.textContent?.trim();
    if (!title || title === "Nothing playing") return null;
    try {
      const rows = await api("/playlist");
      const artist = (document.getElementById("npSub")?.textContent || "").split(" — ")[0].trim();
      const hit = rows.find(t => String(t.title || "").trim() === title && (!artist || String(t.artist || "").trim() === artist));
      if (hit) window.__dakshNowPlayingTrack = hit;
      return hit || null;
    } catch { return null; }
  }

  async function playlistAction() {
    const t = await currentTrack();
    if (!t?.id && !t?.track_id) return;
    try {
      const rows = await api("/playlist");
      const existing = rows.find(x => String(x.id) === String(t.id ?? t.track_id));
      const b = document.getElementById("npPlaylistIcon");
      if (existing) {
        await api(`/playlist/${encodeURIComponent(existing.entry_id)}`, { method: "DELETE" });
        if (b) { b.textContent = "＋"; b.title = "Add to Playlist"; }
      } else {
        await api("/playlist", { method: "POST", body: JSON.stringify(t) });
        if (b) { b.textContent = "−"; b.title = "Remove from Playlist"; }
      }
    } catch (e) { window.dispatchEvent(new CustomEvent("daksh-toast", { detail: e.message })); }
  }

  async function updatePlaylistIcon() {
    const t = await currentTrack();
    const b = document.getElementById("npPlaylistIcon");
    if (!b || !t) return;
    try {
      const rows = await api("/playlist");
      const exists = rows.some(x => String(x.id) === String(t.id ?? t.track_id));
      b.textContent = exists ? "−" : "＋";
      b.title = exists ? "Remove from Playlist" : "Add to Playlist";
    } catch {}
  }

  function showInfo(t) {
    let o = document.getElementById("dakshSongInfo");
    if (!o) {
      o = document.createElement("div"); o.id = "dakshSongInfo";
      o.innerHTML = `<div class="dsi-head"><b>Song Info</b><button id="dsiClose">MENU</button></div><div id="dsiBody"></div>`;
      document.getElementById("screen")?.appendChild(o);
      document.getElementById("dsiClose").onclick = () => o.remove();
    }
    const fields = [["Title",t.title],["Artist",t.artist],["Album",t.album],["ISRC",t.isrc],["Source",t.source],["Duration",t.duration_ms ? `${Math.round(Number(t.duration_ms)/1000)}s` : "—"]];
    document.getElementById("dsiBody").innerHTML = fields.filter(x => x[1] != null && x[1] !== "").map(x => `<div><span>${esc(x[0])}</span><b>${esc(x[1])}</b></div>`).join("");
  }

  document.getElementById("npQueueIcon")?.addEventListener("click", () => window.__dakshOpenQueue?.());
  document.getElementById("npPlaylistIcon")?.addEventListener("click", playlistAction);
  document.getElementById("npInfoIcon")?.addEventListener("click", async () => { const t = await currentTrack(); if (t) showInfo(t); });

  audio.addEventListener("play", () => { updatePlaylistIcon(); });
  setInterval(updatePlaylistIcon, 2500);

  const style = document.createElement("style");
  style.textContent = `
    .device{width:340px}
    .screen{height:250px}
    .nowplaying{position:relative;justify-content:flex-start;padding:12px 62px 12px 14px;gap:6px}
    .nowplaying .art{width:86px;height:86px}
    .nowplaying .np-title{margin-top:1px;max-width:100%}
    .nowplaying .np-sub{max-width:100%}
    .nowplaying .np-progress{margin-top:9px;width:100%}
    .np-actions{position:absolute;right:7px;bottom:13px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:9px;margin:0;z-index:4}
    .np-actions button{border:0;background:transparent;color:var(--screen-sub);font-size:18px;line-height:1;padding:2px 4px;cursor:pointer;width:28px;height:28px}
    .np-actions button:hover{color:var(--screen-ink);transform:scale(1.08)}
    .np-bar{cursor:pointer;touch-action:none;height:6px}
    .np-bar .fill{pointer-events:none}
    .np-bar:focus{outline:1px solid var(--accent);outline-offset:2px}
    #dakshSongInfo{position:absolute;inset:22px 0 0;background:linear-gradient(180deg,var(--screen-top),var(--screen-bg));z-index:40;color:var(--screen-ink)}
    .dsi-head{display:flex;justify-content:space-between;padding:7px 9px;border-bottom:1px solid rgba(0,0,0,.12);font-size:11px}.dsi-head button{border:0;background:transparent;color:var(--screen-sub);font-size:9px;font-weight:700}
    #dsiBody{padding:7px 9px}#dsiBody div{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(0,0,0,.06);font-size:9px}#dsiBody span{color:var(--screen-sub)}#dsiBody b{max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  `;
  document.head.appendChild(style);
})();
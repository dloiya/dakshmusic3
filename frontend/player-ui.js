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

  const getTrack = () => window.__dakshNowPlayingTrack || null;

  async function playlistAction() {
    const t = getTrack();
    if (!t?.id) return;
    try {
      const rows = await api("/playlist");
      const existing = rows.find(x => x.id === t.id);
      if (existing) {
        await api(`/playlist/${encodeURIComponent(existing.entry_id)}`, { method: "DELETE" });
        const b = document.getElementById("npPlaylistIcon"); if (b) { b.textContent = "＋"; b.title = "Add to Playlist"; }
      } else {
        await api("/playlist", { method: "POST", body: JSON.stringify(t) });
        const b = document.getElementById("npPlaylistIcon"); if (b) { b.textContent = "−"; b.title = "Remove from Playlist"; }
      }
    } catch (e) { window.dispatchEvent(new CustomEvent("daksh-toast", { detail: e.message })); }
  }

  document.getElementById("npQueueIcon")?.addEventListener("click", () => window.__dakshOpenQueue?.());
  document.getElementById("npPlaylistIcon")?.addEventListener("click", playlistAction);
  document.getElementById("npInfoIcon")?.addEventListener("click", () => { const t = getTrack(); if (t) window.__dakshOpenInfo?.(t); });

  const style = document.createElement("style");
  style.textContent = `.np-actions{display:flex;justify-content:center;gap:12px;margin-top:4px}.np-actions button{border:0;background:transparent;color:var(--screen-sub);font-size:17px;line-height:1;padding:2px 5px;cursor:pointer}.np-actions button:hover{color:var(--screen-ink)}.np-bar{cursor:pointer;touch-action:none}.np-bar:focus{outline:1px solid var(--accent);outline-offset:2px}`;
  document.head.appendChild(style);
})();
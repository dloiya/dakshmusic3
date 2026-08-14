(() => {
  function esc(v) {
    return String(v ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#039;"}[c]));
  }

  function readTrack() {
    const title = document.getElementById("npTitle")?.textContent?.trim() || "Nothing playing";
    const sub = document.getElementById("npSub")?.textContent?.trim() || "";
    const parts = sub.split(/\s+—\s+/);
    return { title, artist: parts[0] || "", album: parts.slice(1).join(" — ") || "" };
  }

  function openDetails() {
    const t = readTrack();
    if (!t.title || t.title === "Nothing playing") return;
    let modal = document.getElementById("songInfoModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "songInfoModal";
      modal.innerHTML = `<div class="song-info-card" role="dialog" aria-modal="true" aria-labelledby="songInfoTitle">
        <div class="song-info-head"><strong id="songInfoTitle">Song Info</strong><button id="songInfoClose" type="button" aria-label="Close">×</button></div>
        <dl id="songInfoBody"></dl>
      </div>`;
      document.body.appendChild(modal);
      modal.addEventListener("click", e => { if (e.target === modal) modal.hidden = true; });
      modal.querySelector("#songInfoClose").addEventListener("click", () => { modal.hidden = true; });
      document.addEventListener("keydown", e => { if (e.key === "Escape") modal.hidden = true; });
    }
    modal.querySelector("#songInfoBody").innerHTML = [
      ["Title", t.title], ["Artist", t.artist], ["Album", t.album]
    ].filter(([,v]) => v).map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    modal.hidden = false;
  }

  function init() {
    const player = document.querySelector("#view-nowplaying .nowplaying");
    if (!player) return false;
    let button = document.getElementById("npInfoIcon");
    if (!button) {
      const actions = player.querySelector(".np-actions") || (() => {
        const el = document.createElement("div");
        el.className = "np-actions";
        player.appendChild(el);
        return el;
      })();
      button = document.createElement("button");
      button.id = "npInfoIcon";
      button.type = "button";
      button.title = "Song Info";
      button.setAttribute("aria-label", "Song Info");
      button.textContent = "ⓘ";
      actions.appendChild(button);
    }
    if (!button.dataset.detailsBound) {
      button.dataset.detailsBound = "1";
      button.addEventListener("click", e => { e.preventDefault(); e.stopImmediatePropagation(); openDetails(); }, true);
    }
    return true;
  }

  const style = document.createElement("style");
  style.textContent = `
    .song-info-card{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:220px;max-width:calc(100% - 24px);background:#f7f7f4;color:#1b1f1c;border:1px solid #cfcdc7;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.28);padding:8px;z-index:50}
    #songInfoModal{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:9999}
    #songInfoModal[hidden]{display:none}
    .song-info-head{display:flex;align-items:center;justify-content:space-between;font-size:12px;margin-bottom:6px}
    .song-info-head button{border:0;background:transparent;font-size:18px;cursor:pointer;color:#5b625d}
    #songInfoBody{display:grid;grid-template-columns:58px 1fr;gap:4px 7px;margin:0;font-size:10px}
    #songInfoBody dt{font-weight:700;color:#5b625d} #songInfoBody dd{margin:0;word-break:break-word}
  `;
  document.head.appendChild(style);

  if (!init()) {
    const observer = new MutationObserver(() => { if (init()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();

(() => {
  const API = "/api/v1";
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[c]));
  let timer = null;
  let loading = false;

  async function api(path) {
    const response = await fetch(API + path, { credentials: "include", cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function close() {
    clearTimeout(timer);
    timer = null;
    document.getElementById("dakshAcqOverlay")?.remove();
  }

  async function refresh() {
    if (loading) return;
    const overlay = document.getElementById("dakshAcqOverlay");
    if (!overlay) return;
    const list = document.getElementById("daqList");
    const summary = document.getElementById("daqSummary");
    loading = true;
    try {
      const [s, d] = await Promise.all([api("/acquisitions/summary"), api("/acquisitions?limit=100")]);
      const c = s.counts || {};
      summary.innerHTML = ["queued", "dispatched", "running", "complete", "failed"].map(k => `<span>${k[0].toUpperCase()+k.slice(1)} ${c[k] || 0}</span>`).join("");
      list.innerHTML = (d.items || []).map(j => `<div class="daq-row ${j.status === "failed" ? "failed" : ""}"><div class="daq-art">${j.artwork_url ? `<img src="${esc(j.artwork_url)}" loading="lazy">` : "♪"}</div><div class="daq-info"><b>${esc(j.title || "Untitled")}</b><small>${esc(j.artist || "")}${j.album ? ` · ${esc(j.album)}` : ""}</small><small class="daq-status ${esc(j.status)}">${esc(j.status)}${j.provider ? ` · ${esc(j.provider)}` : ""}</small><small>${esc(j.job_id || "")}</small>${j.error ? `<small class="daq-error">${esc(j.error)}</small>` : ""}</div></div>`).join("") || `<div class="daq-empty">No acquisition jobs.</div>`;
    } catch (error) {
      list.innerHTML = `<div class="daq-empty">${esc(error.message)}</div>`;
    } finally {
      loading = false;
      if (document.getElementById("dakshAcqOverlay")) timer = setTimeout(refresh, 5000);
    }
  }

  function open() {
    close();
    const overlay = document.createElement("div");
    overlay.id = "dakshAcqOverlay";
    overlay.innerHTML = `<div class="daq-head"><b>Acquisitions</b><div><button id="daqRefresh">REFRESH</button><button id="daqClose">MENU</button></div></div><div id="daqSummary"></div><div class="daq-label">GitHub acquisition jobs</div><div id="daqList"><div class="daq-loading">Loading…</div></div>`;
    document.getElementById("screen")?.appendChild(overlay);
    overlay.querySelector("#daqClose").onclick = close;
    overlay.querySelector("#daqRefresh").onclick = refresh;
    refresh();
  }

  function injectHomeItem() {
    const list = document.getElementById("list-home");
    if (!list || list.querySelector("[data-daksh-acq]")) return;
    const li = document.createElement("li");
    li.dataset.dakshAcq = "1";
    li.innerHTML = '<div class="l"><span class="name">Acquisitions</span></div><span class="chev">▸</span>';
    li.onclick = open;
    list.appendChild(li);
  }

  new MutationObserver(injectHomeItem).observe(document.body, { subtree: true, childList: true });
  injectHomeItem();

  const style = document.createElement("style");
  style.textContent = `#dakshAcqOverlay{position:absolute;inset:22px 0 0;background:linear-gradient(180deg,var(--screen-top),var(--screen-bg));z-index:30;color:var(--screen-ink);display:flex;flex-direction:column}.daq-head{display:flex;align-items:center;justify-content:space-between;padding:7px 9px;border-bottom:1px solid rgba(0,0,0,.12);font-size:11px}.daq-head button{border:0;background:transparent;font-size:9px;font-weight:700;color:var(--screen-sub);cursor:pointer;margin-left:8px}.daq-label{padding:4px 8px 2px;font-size:7.5px;color:var(--screen-sub);font-weight:700;text-transform:uppercase;letter-spacing:.05em}#daqSummary{display:flex;gap:7px;flex-wrap:wrap;padding:5px 8px;font-size:8px;color:var(--screen-sub);border-bottom:1px solid rgba(0,0,0,.07)}#daqList{overflow:auto;padding:3px 0}.daq-row{display:flex;gap:7px;padding:6px 8px;border-bottom:1px solid rgba(0,0,0,.06);min-width:0}.daq-art{width:30px;height:30px;flex:none;border-radius:3px;background:#8995a0;color:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden}.daq-art img{width:100%;height:100%;object-fit:cover}.daq-info{min-width:0;display:flex;flex-direction:column;gap:1px}.daq-info b,.daq-info small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.daq-info b{font-size:10px}.daq-info small{font-size:8.5px;color:var(--screen-sub)}.daq-status.complete{color:#398744}.daq-status.failed{color:var(--danger)}.daq-row.failed{box-shadow:inset 3px 0 0 var(--danger)}.daq-error{color:var(--danger)!important}.daq-loading,.daq-empty{padding:30px 12px;text-align:center;font-size:10px;color:var(--screen-sub)}`;
  document.head.appendChild(style);
  window.__dakshOpenAcquisitions = open;
})();

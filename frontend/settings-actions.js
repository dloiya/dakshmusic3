(() => {
  const API = "/api/v1";
  const esc = v => String(v ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#039;"}[c]));

  async function readJson(response) {
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (quoted && text[i + 1] === '"') { field += '"'; i++; }
        else quoted = !quoted;
      } else if (c === "," && !quoted) { row.push(field.trim()); field = ""; }
      else if ((c === "\n" || c === "\r") && !quoted) {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field.trim()); field = "";
        if (row.some(Boolean)) rows.push(row);
        row = [];
      } else field += c;
    }
    if (field.length || row.length) { row.push(field.trim()); if (row.some(Boolean)) rows.push(row); }
    if (rows.length < 2) return [];
    const headers = rows[0].map(h => h.replace(/^\uFEFF/, "").trim().toLowerCase());
    const find = (...names) => names.map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1;
    const ti=find("title","name","song","track"), ar=find("artist","artist name","artists"), al=find("album","album name");
    const sid=find("source_id","source id","id","track id","apple id"), surl=find("source_url","source url","url","link");
    const dur=find("duration_ms","duration","duration ms"), art=find("artwork_url","artwork url","artwork","cover","cover_url"), isrc=find("isrc");
    const cache=find("100 cache","100_cache","100cache","cache");
    if (ti < 0) throw new Error("CSV must contain a Title, Name, Song, or Track column.");
    return rows.slice(1).map(r => ({
      title:r[ti]||"", artist:ar>=0?r[ar]||"":"", album:al>=0?r[al]||null:null,
      source_id:sid>=0?r[sid]||null:null, source_url:surl>=0?r[surl]||null:null,
      duration_ms:dur>=0?Number(r[dur])||null:null, artwork_url:art>=0?r[art]||null:null,
      isrc:isrc>=0?r[isrc]||null:null, "100 Cache":cache>=0?r[cache]||"":""
    })).filter(x => x.title);
  }

  function ensureModal() {
    let modal = document.getElementById("libraryImportModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "libraryImportModal";
    modal.innerHTML = `
      <div class="library-import-backdrop"></div>
      <div class="library-import-dialog" role="dialog" aria-modal="true" aria-labelledby="libraryImportTitle">
        <div class="library-import-head">
          <strong id="libraryImportTitle">Import Library CSV</strong>
          <button type="button" id="libraryImportClose" aria-label="Close">×</button>
        </div>
        <div class="library-import-body">
          <input id="libraryCsvFile" type="file" accept=".csv,text/csv">
          <button type="button" id="libraryCsvChoose">Choose CSV</button>
          <div id="libraryCsvName" class="library-import-file">No file selected</div>
          <button type="button" id="libraryCsvStart" class="library-import-primary" disabled>Start Import</button>
          <div id="libraryImportProcesses" class="library-import-processes" aria-live="polite">
            <div class="library-import-process" data-process="file"><span class="state">○</span><span>Read CSV file</span><small>Waiting</small></div>
            <div class="library-import-process" data-process="parse"><span class="state">○</span><span>Parse and validate tracks</span><small>Waiting</small></div>
            <div class="library-import-process" data-process="seed"><span class="state">○</span><span>Import library into D1</span><small>Waiting</small></div>
            <div class="library-import-process" data-process="cache"><span class="state">○</span><span>Apply 100 Cache selection</span><small>Waiting</small></div>
            <div class="library-import-process" data-process="metadata"><span class="state">○</span><span>Queue metadata enrichment</span><small>Waiting</small></div>
            <div class="library-import-process" data-process="done"><span class="state">○</span><span>Complete</span><small>Waiting</small></div>
          </div>
          <div id="libraryImportStatus" class="library-import-status"></div>
        </div>
      </div>`;
    const style = document.createElement("style");
    style.id = "library-import-modal-style";
    style.textContent = `
      #libraryImportModal{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}
      .library-import-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.58)}
      .library-import-dialog{position:relative;width:min(340px,calc(100vw - 28px));max-height:calc(100vh - 40px);overflow:auto;background:#f2f1ee;border:1px solid #cfcdc7;border-radius:12px;box-shadow:0 18px 45px rgba(0,0,0,.4);color:#1b1f1c}
      .library-import-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #d4d1ca;background:#faf9f7}
      .library-import-head strong{font-size:13px}
      .library-import-head button{border:0;background:transparent;font-size:22px;line-height:1;color:#5b625d;cursor:pointer;padding:0 2px}
      .library-import-body{padding:12px}
      #libraryCsvFile{display:none}
      #libraryCsvChoose,.library-import-primary{width:100%;border:1px solid #b9bdb8;border-radius:6px;padding:8px;background:#fff;color:#1b1f1c;font:600 11px inherit;cursor:pointer}
      .library-import-primary{margin-top:7px;background:#3c6fb5;color:#fff;border-color:#3c6fb5}
      .library-import-primary:disabled{opacity:.45;cursor:not-allowed}
      .library-import-file{font-size:10px;color:#5b625d;margin:7px 1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .library-import-processes{margin-top:12px;border:1px solid #d4d1ca;border-radius:7px;background:#fff;overflow:hidden}
      .library-import-process{display:grid;grid-template-columns:22px 1fr auto;align-items:center;gap:5px;padding:7px 8px;border-bottom:1px solid #eee;font-size:10px}
      .library-import-process:last-child{border-bottom:0}
      .library-import-process .state{font-size:13px;text-align:center;color:#8b887f}
      .library-import-process small{font-size:8px;color:#8b887f}
      .library-import-process.running .state{color:#3c6fb5}.library-import-process.running small{color:#3c6fb5}
      .library-import-process.done .state{color:#3f9e4d}.library-import-process.done small{color:#3f9e4d}
      .library-import-process.error .state{color:#b34c3c}.library-import-process.error small{color:#b34c3c}
      .library-import-status{min-height:15px;margin-top:8px;font-size:9.5px;color:#5b625d;white-space:pre-wrap}
    `;
    document.head.appendChild(style);
    document.body.appendChild(modal);

    const file = modal.querySelector("#libraryCsvFile");
    const choose = modal.querySelector("#libraryCsvChoose");
    const start = modal.querySelector("#libraryCsvStart");
    const close = modal.querySelector("#libraryImportClose");
    choose.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const selected = file.files?.[0];
      modal.querySelector("#libraryCsvName").textContent = selected ? `${selected.name} · ${Math.round(selected.size / 1024)} KB` : "No file selected";
      start.disabled = !selected;
      if (selected) setProcess(modal,"file","done","Ready");
    });
    close.addEventListener("click", () => modal.remove());
    modal.querySelector(".library-import-backdrop").addEventListener("click", () => modal.remove());
    start.addEventListener("click", () => runImport(modal));
    return modal;
  }

  function setProcess(modal, key, state, text) {
    const el = modal.querySelector(`[data-process="${key}"]`); if (!el) return;
    el.classList.remove("running","done","error");
    if (state) el.classList.add(state);
    el.querySelector(".state").textContent = state === "done" ? "✓" : state === "error" ? "×" : state === "running" ? "…" : "○";
    el.querySelector("small").textContent = text;
  }

  async function runImport(modal) {
    const file = modal.querySelector("#libraryCsvFile").files?.[0];
    const start = modal.querySelector("#libraryCsvStart");
    const status = modal.querySelector("#libraryImportStatus");
    if (!file || start.disabled) return;
    start.disabled = true;
    try {
      setProcess(modal,"file","running","Reading…");
      const text = await file.text();
      setProcess(modal,"file","done",`${Math.max(0,text.length).toLocaleString()} bytes`);
      setProcess(modal,"parse","running","Parsing…");
      const items = parseCSV(text);
      if (!items.length) throw new Error("No valid tracks found in the CSV.");
      const cached = items.filter(x => ["Y","YES","TRUE","1"].includes(String(x["100 Cache"]||"").trim().toUpperCase())).length;
      setProcess(modal,"parse","done",`${items.length.toLocaleString()} tracks`);
      setProcess(modal,"seed","running","Uploading to D1…");
      const response = await fetch(`${API}/library/seed`, { method:"POST", credentials:"include", headers:{"Content-Type":"application/json"}, body:JSON.stringify({items}) });
      const data = await readJson(response);
      setProcess(modal,"seed","done",`${data.playlist_entries || items.length} rows`);
      setProcess(modal,"cache","running","Applying selection…");
      setProcess(modal,"cache","done",`${data.cache_entries ?? cached} selected`);
      setProcess(modal,"metadata","running","Deferred to Worker backfill…");
      setProcess(modal,"metadata","done",`${data.metadata_missing_after_seed ?? 0} pending`);
      setProcess(modal,"done","done","Import complete");
      status.textContent = `Imported ${items.length.toLocaleString()} tracks successfully.`;
    } catch (e) {
      const running = [...modal.querySelectorAll(".library-import-process.running")].at(-1);
      if (running) { running.classList.remove("running"); running.classList.add("error"); running.querySelector(".state").textContent = "×"; running.querySelector("small").textContent = "Failed"; }
      status.textContent = e.message || "Library CSV import failed.";
      start.disabled = false;
    }
  }

  window.openLibraryCsvImport = function openLibraryCsvImport() {
    ensureModal();
  };

  window.exportPlaylistExcel = async function exportPlaylistExcel() {
    try {
      const response = await fetch(`${API}/playlist/export`, {credentials:"include"});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob=await response.blob(), url=URL.createObjectURL(blob), a=document.createElement("a");
      a.href=url; a.download="daksh-music-playlist.xlsx"; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(e) { alert(`Export failed: ${e.message}`); }
  };

  function bindFieldButtons() {
    for (const id of ["searchGo","albumGo","appleGo","clearAllGo"]) {
      const el=document.getElementById(id);
      if (el && el.dataset.actionBound !== "1") {
        el.dataset.actionBound="1";
        el.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();document.getElementById("btnCenter")?.click();});
      }
    }
  }

  bindFieldButtons();
  new MutationObserver(bindFieldButtons).observe(document.body,{childList:true,subtree:true});
})();

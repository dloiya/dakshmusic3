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

  async function importFile(file) {
    const status = document.getElementById("libraryImportStatus");
    try {
      const items = parseCSV(await file.text());
      if (!items.length) throw new Error("No valid tracks found in the CSV.");
      status.textContent = `Importing ${items.length} tracks…`;
      const data = await readJson(await fetch(`${API}/library/seed`, {
        method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({items})
      }));
      status.textContent = `Imported ${data.playlist_entries || items.length} tracks · Top Cache ${data.cache_entries || 0}.`;
    } catch (e) { status.textContent = e.message || "Library CSV import failed."; }
  }

  function showLibraryImport() {
    let view = document.getElementById("view-librarycsv");
    if (!view) {
      view = document.createElement("div");
      view.className = "view active";
      view.id = "view-librarycsv";
      view.innerHTML = `<div class="field-screen"><label>Library CSV</label><input id="libraryCsvFile" type="file" accept=".csv,text/csv"><div class="go" id="libraryCsvGo">Import CSV</div><div class="status" id="libraryImportStatus">Choose your library CSV.</div><div class="hint">The CSV should contain Title and Artist columns. A 100 Cache column is honored when present.</div></div>`;
      document.getElementById("screen")?.appendChild(view);
    }
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    view.classList.add("active");
    document.getElementById("screenTitle").textContent = "Import Library CSV";
    const input=document.getElementById("libraryCsvFile"), go=document.getElementById("libraryCsvGo");
    if (go && go.dataset.bound !== "1") {
      go.dataset.bound="1";
      go.addEventListener("click",()=>{if(input.files?.[0]) importFile(input.files[0]); else input.click();});
    }
    input?.focus();
  }

  window.openLibraryCsvImport = showLibraryImport;

  window.exportPlaylistExcel = async function exportPlaylistExcel() {
    try {
      const response = await fetch(`${API}/playlist/export`, {credentials:"include"});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob=await response.blob(), url=URL.createObjectURL(blob), a=document.createElement("a");
      a.href=url; a.download="daksh-music-playlist.xlsx"; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(e) { alert(`Export failed: ${e.message}`); }
  };

  function clickCenter() { document.getElementById("btnCenter")?.click(); }
  function bindFieldButtons() {
    for (const id of ["searchGo","albumGo","appleGo","clearAllGo"]) {
      const el=document.getElementById(id);
      if (el && el.dataset.actionBound !== "1") {
        el.dataset.actionBound="1";
        el.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();clickCenter();});
      }
    }
  }

  bindFieldButtons();
  new MutationObserver(bindFieldButtons).observe(document.body,{childList:true,subtree:true});
})();

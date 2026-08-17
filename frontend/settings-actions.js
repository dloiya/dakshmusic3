(() => {
  const API = "/api/v1";

  function setStatus(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  async function readJson(response) {
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function importLibraryItems(items, statusId = "libraryImportStatus") {
    if (!items.length) throw new Error("No valid tracks found in the CSV.");
    setStatus(statusId, `Importing ${items.length} tracks…`);
    const response = await fetch(`${API}/library/seed`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await readJson(response);
    setStatus(statusId, `Imported ${data.playlist_entries || items.length} tracks. Top Cache: ${data.cache_entries || 0}.`);
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
    const title = find("title", "name", "song", "track");
    const artist = find("artist", "artist name", "artists");
    const album = find("album", "album name");
    const sourceId = find("source_id", "source id", "id", "track id", "apple id");
    const sourceUrl = find("source_url", "source url", "url", "link");
    const duration = find("duration_ms", "duration", "duration ms");
    const artwork = find("artwork_url", "artwork url", "artwork", "cover", "cover_url");
    const isrc = find("isrc");
    const cache = find("100 cache", "100_cache", "100cache", "cache");
    if (title < 0) throw new Error("CSV must contain a Title/Name/Song column.");
    return rows.slice(1).map(r => ({
      title: r[title] || "",
      artist: artist >= 0 ? r[artist] || "" : "",
      album: album >= 0 ? r[album] || null : null,
      source_id: sourceId >= 0 ? r[sourceId] || null : null,
      source_url: sourceUrl >= 0 ? r[sourceUrl] || null : null,
      duration_ms: duration >= 0 ? Number(r[duration]) || null : null,
      artwork_url: artwork >= 0 ? r[artwork] || null : null,
      isrc: isrc >= 0 ? r[isrc] || null : null,
      "100 Cache": cache >= 0 ? r[cache] || "" : "",
    })).filter(x => x.title);
  }

  window.openLibraryCsvImport = function openLibraryCsvImport() {
    const s = {
      key: "librarycsv",
      title: "Import Library CSV",
      kind: "field",
      selected: 0,
      items: [],
      onGo: () => document.getElementById("libraryCsvFile")?.click(),
    };
    window.__dakshPushScreen?.(s);
    if (!window.__dakshPushScreen) {
      const input = document.getElementById("libraryCsvFile");
      input?.click();
      return;
    }
    setTimeout(() => document.getElementById("libraryCsvFile")?.focus(), 50);
  };

  function installLibraryView() {
    if (!document.getElementById("libraryCsvFile")) {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "libraryCsvFile";
      input.accept = ".csv,text/csv";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const items = parseCSV(await file.text());
          await importLibraryItems(items);
          alert(`Library imported: ${items.length} tracks.`);
        } catch (e) {
          alert(e.message || "Library CSV import failed.");
        } finally { input.value = ""; }
      });
    }
  }

  window.exportPlaylistExcel = async function exportPlaylistExcel() {
    try {
      const response = await fetch(`${API}/playlist/export`, { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "daksh-music-playlist.xlsx";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { alert(`Export failed: ${e.message}`); }
  };

  function bindFieldButtons() {
    const handlers = {
      searchGo: () => window.__dakshSelectCurrent?.(),
      albumGo: () => window.__dakshSelectCurrent?.(),
      appleGo: () => window.__dakshSelectCurrent?.(),
      clearAllGo: () => window.__dakshRunClearAll?.(),
    };
    for (const [id, fn] of Object.entries(handlers)) {
      const el = document.getElementById(id);
      if (el && el.dataset.actionBound !== "1") {
        el.dataset.actionBound = "1";
        el.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); fn(); });
      }
    }
  }

  installLibraryView();
  bindFieldButtons();
  new MutationObserver(() => { installLibraryView(); bindFieldButtons(); }).observe(document.body, { childList: true, subtree: true });
})();

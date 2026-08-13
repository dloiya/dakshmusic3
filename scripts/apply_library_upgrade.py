from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

# Keep the existing routing/logic intact; make only targeted changes.
for name in ("serverless/entry.js", "serverless/worker.js"):
    p = ROOT / name
    text = p.read_text(encoding="utf-8")
    original = text

    # The current application intentionally keeps play counts at zero.
    text = re.sub(
        r"play_count\s*=\s*(?:COALESCE\([^\n;]*?\)|play_count)\s*\+\s*1",
        "play_count = 0",
        text,
        flags=re.I,
    )
    text = re.sub(r"play_count\s*=\s*play_count\s*\+\s*1", "play_count = 0", text, flags=re.I)

    # Expand the protected top-played cache from 100 to 200 only inside refreshTopPlayed.
    start = text.find("async function refreshTopPlayed")
    if start >= 0:
        end = text.find("async function dispatchWarm", start)
        if end < 0:
            end = len(text)
        block = text[start:end].replace("LIMIT 100", "LIMIT 200")
        text = text[:start] + block + text[end:]

    if text != original:
        p.write_text(text, encoding="utf-8")

# Add CSV import + Excel export controls without rewriting the existing UI.
p = ROOT / "frontend/app.js"
text = p.read_text(encoding="utf-8")
original = text

anchor = '{ label: "Import Apple Music", action: openAppleImport },'
replacement = anchor + '\n        { label: "Import Library CSV", action: openLibraryCsvImport },\n        { label: "Export Playlist Excel", action: exportPlaylistExcel },'
if anchor in text and "openLibraryCsvImport" not in text:
    text = text.replace(anchor, replacement, 1)

if "function openLibraryCsvImport()" not in text:
    addition = r'''

  /* ---------- CSV library seed / Excel export ---------- */

  function parseLibraryCsv(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], n = text[i + 1];
      if (c === '"') {
        if (quoted && n === '"') { cell += '"'; i++; }
        else quoted = !quoted;
      } else if (c === "," && !quoted) {
        row.push(cell); cell = "";
      } else if ((c === "\n" || c === "\r") && !quoted) {
        if (c === "\r" && n === "\n") i++;
        row.push(cell); cell = "";
        if (row.some(v => v.trim() !== "")) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some(v => v.trim() !== "")) rows.push(row);
    if (!rows.length) return [];
    const headers = rows[0].map(h => h.trim());
    return rows.slice(1).map(values => Object.fromEntries(headers.map((h, i) => [h, (values[i] || "").trim()])));
  }

  async function openLibraryCsvImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        toast("Reading library CSV…", 4000);
        const rows = parseLibraryCsv(await file.text());
        const items = rows.filter(r => r["Track name"]).map(r => ({
          title: r["Track name"],
          artist: r["Artist name"] || "",
          album: r["Album"] || "",
          playlist_name: r["Playlist name"] || "Playlist",
          type: r["Type"] || "Playlist",
          isrc: r["ISRC"] || "",
          source_id: r["Apple - id"] || "",
          apple_id: r["Apple - id"] || "",
          cache: String(r["100 Cache"] || "").toUpperCase() === "Y",
          playCount: 0,
          play_count: 0,
        }));
        if (!items.length) throw new Error("No tracks found in CSV");
        const playlistName = items[0].playlist_name || "Playlist";
        await appleMusicImport(items);
        const seeded = await api("/library/seed", {
          method: "POST",
          body: JSON.stringify({ playlist_name: playlistName, items }),
        });
        toast(`Imported ${seeded.playlist_entries} tracks; ${seeded.cache_entries} cached`, 5000);
        await openPlaylist();
      } catch (e) {
        toast(`Library import failed: ${e.message}`, 6000);
      }
    };
    input.click();
  }

  function exportPlaylistExcel() {
    window.location.href = API + "/playlist/export";
  }
'''
    text = text.replace("\n})();", addition + "\n})();", 1)

if text != original:
    p.write_text(text, encoding="utf-8")

print("library upgrade patch applied")

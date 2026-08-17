from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
P = ROOT / "serverless" / "library.js"
text = P.read_text(encoding="utf-8")

# The library was consolidated and now performs metadata enrichment through
# serverless/metadata_backfill.js. Keep this script compatible with both the
# older seedLibrary implementation and the current seed() implementation.
if "async function seedLibrary(env, req, ctx) {" in text:
    # Legacy codebase: inject the synchronous enrichment helper used by the
    # original seeding flow.
    if "async function enrichSeedTrackMetadata" not in text:
        helper = r'''

async function enrichSeedTrackMetadata(env, track) {
  const needsDuration = !(Number(track?.duration_ms) > 0);
  const needsArtwork = !String(track?.artwork_url || "").trim();
  if (!needsDuration && !needsArtwork) return track;

  let duration = needsDuration ? null : Number(track.duration_ms);
  let artwork = needsArtwork ? null : track.artwork_url;
  const source = String(track?.source || "").toLowerCase();

  const apply = (item) => {
    if (!item) return;
    if (!duration && Number(item.duration) > 0) duration = Number(item.duration) * 1000;
    if (!artwork) artwork = item.cover_xl || item.cover_big || item.cover_medium || item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium || null;
  };

  try {
    let deezerId = null;
    if (source === "deezer" && track.source_id) deezerId = String(track.source_id).match(/(\d+)$/)?.[1] || null;
    if (!deezerId && track.source_url) deezerId = String(track.source_url).match(/deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/i)?.[1] || null;
    if (deezerId) {
      const response = await fetch(`https://api.deezer.com/track/${encodeURIComponent(deezerId)}`);
      if (response.ok) apply(await response.json());
    }

    if ((needsDuration && !duration) || (needsArtwork && !artwork)) {
      const title = String(track.title || "").trim();
      const artist = String(track.artist || "").trim();
      if (title && artist) {
        const query = encodeURIComponent(`track:"${title}" artist:"${artist}"`);
        const response = await fetch(`https://api.deezer.com/search?q=${query}&limit=10`);
        if (response.ok) {
          const data = await response.json();
          const exact = (data.data || []).find(item =>
            String(item.title || "").trim().toLowerCase() === title.toLowerCase() &&
            String(item.artist?.name || "").trim().toLowerCase() === artist.toLowerCase()
          );
          apply(exact);
        }
      }
    }
  } catch (error) {
    console.warn("Seed metadata enrichment failed", track?.id, error?.message || error);
  }

  const updates = [];
  const binds = [];
  if (needsDuration && duration) { updates.push("duration_ms=?"); binds.push(duration); track.duration_ms = duration; }
  if (needsArtwork && artwork) { updates.push("artwork_url=?"); binds.push(artwork); track.artwork_url = artwork; }
  if (updates.length) {
    binds.push(track.id);
    await env.DB.prepare(`UPDATE tracks SET ${updates.join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...binds).run();
  }
  return track;
}
'''
        anchor = "async function seedLibrary(env, req, ctx) {"
        text = text.replace(anchor, helper + "\n" + anchor, 1)

    old = '''  for (let i = 0; i < matched.length; i++) {
    const { track } = matched[i];
    await env.DB.prepare(`INSERT OR IGNORE INTO playlist_entries(track_id,position,title,artist,album,artwork_url,duration_ms) VALUES(?,?,?,?,?,?,?)`).bind(track.id, i + 1, track.title, track.artist, track.album, track.artwork_url, track.duration_ms).run();
  }'''
    new = '''  for (let i = 0; i < matched.length; i += 8) {
    const batch = matched.slice(i, i + 8);
    await Promise.all(batch.map(async entry => {
      entry.track = await enrichSeedTrackMetadata(env, entry.track);
    }));
  }
  for (let i = 0; i < matched.length; i++) {
    const { track } = matched[i];
    await env.DB.prepare(`INSERT OR IGNORE INTO playlist_entries(track_id,position,title,artist,album,artwork_url,duration_ms) VALUES(?,?,?,?,?,?,?)`).bind(track.id, i + 1, track.title, track.artist, track.album, track.artwork_url, track.duration_ms).run();
  }'''
    if old in text:
        text = text.replace(old, new, 1)
    else:
        raise SystemExit("legacy playlist insertion block not found")

elif "async function seed(env,req) {" in text:
    # Current library architecture already imports metadata_backfill.js and
    # deliberately defers enrichment after seeding. Nothing needs patching.
    print("seed metadata enrichment already handled by metadata_backfill.js")
else:
    raise SystemExit("unsupported library.js: no known seed function found")

P.write_text(text, encoding="utf-8")
print("seed metadata enrichment check passed")

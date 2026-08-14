from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
P = ROOT / "serverless" / "library.js"
text = P.read_text(encoding="utf-8")

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
    // Prefer an exact Deezer catalog lookup whenever the imported track already
    // carries a Deezer ID or URL. This supplies both duration and artwork.
    let deezerId = null;
    if (source === "deezer" && track.source_id) {
      deezerId = String(track.source_id).match(/(\d+)$/)?.[1] || null;
    }
    if (!deezerId && track.source_url) {
      deezerId = String(track.source_url).match(/deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/i)?.[1] || null;
    }
    if (deezerId && (needsDuration || needsArtwork)) {
      const response = await fetch(`https://api.deezer.com/track/${encodeURIComponent(deezerId)}`);
      if (response.ok) apply(await response.json());
    }

    // Otherwise use an exact title + artist Deezer search.
    if ((needsDuration && !duration) || (needsArtwork && !artwork)) {
      const title = String(track.title || "").trim();
      const artist = String(track.artist || "").trim();
      if (title && artist) {
        const query = encodeURIComponent(`track:"${title}" artist:"${artist}"`);
        const response = await fetch(`https://api.deezer.com/search?q=${query}&limit=10`);
        if (response.ok) {
          const data = await response.json();
          const wantedTitle = title.toLowerCase();
          const wantedArtist = artist.toLowerCase();
          const exact = (data.data || []).find(item =>
            String(item.title || "").trim().toLowerCase() === wantedTitle &&
            String(item.artist?.name || "").trim().toLowerCase() === wantedArtist
          );
          apply(exact);
        }
      }
    }

    // Apple is a fallback for Apple imports when Deezer has no exact result.
    if ((needsDuration && !duration) || (needsArtwork && !artwork)) {
      const appleId = String(track.source_id || "").match(/(?:^apple[-_:])?(\d+)$/i)?.[1] ||
        String(track.source_url || "").match(/\/song\/[^/?#]+\/(\d+)(?:\?|#|$)/i)?.[1] || null;
      let result = null;
      if (appleId) {
        const response = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appleId)}&entity=song`);
        if (response.ok) {
          const data = await response.json();
          result = (data.results || []).find(item => item.wrapperType === "track");
        }
      }
      if (!result && track.title && track.artist) {
        const term = encodeURIComponent(`${track.title} ${track.artist}`);
        const response = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=10`);
        if (response.ok) {
          const data = await response.json();
          const wantedTitle = String(track.title).trim().toLowerCase();
          const wantedArtist = String(track.artist).trim().toLowerCase();
          result = (data.results || []).find(item =>
            String(item.trackName || "").trim().toLowerCase() === wantedTitle &&
            String(item.artistName || "").trim().toLowerCase() === wantedArtist
          );
        }
      }
      if (result) {
        if (!duration && Number(result.trackTimeMillis) > 0) duration = Number(result.trackTimeMillis);
        if (!artwork) artwork = result.artworkUrl100 || result.artworkUrl60 || null;
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
    if anchor not in text:
        raise SystemExit("seedLibrary anchor not found")
    text = text.replace(anchor, helper + "\n" + anchor, 1)

# Enrich matched tracks before they are copied into playlist_entries/top cache.
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
if old not in text:
    raise SystemExit("playlist insertion block not found")
text = text.replace(old, new, 1)

P.write_text(text, encoding="utf-8")
print("seed metadata enrichment applied")

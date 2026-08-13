from pathlib import Path
import re

p = Path("serverless/entry.js")
s = p.read_text()

replacement = r'''async function resolveAppleDuration(env, track, trackId) {
  if (track.duration_ms && Number(track.duration_ms) > 0) {
    return track;
  }

  const source = String(track.source || "").toLowerCase();
  const rawSourceId = String(track.source_id || "").trim();

  // Apple imports may be represented as Apple tracks, or may have been
  // resolved to a Deezer-backed track while retaining an Apple natural key.
  // Resolve duration from the provider that actually identifies the track.
  if (source === "apple" && rawSourceId) {
    const catalogId = rawSourceId.replace(/^apple[-_:]/i, "");

    if (/^\d+$/.test(catalogId)) {
      try {
        const response = await fetch(
          `https://itunes.apple.com/lookup?id=${encodeURIComponent(catalogId)}&entity=song`,
          {
            headers: {
              Accept: "application/json",
              "User-Agent": "dakshmusic3-worker",
            },
          }
        );

        if (response.ok) {
          const data = await response.json();
          const song = (data.results || []).find(
            item => item.wrapperType === "track" && Number(item.trackTimeMillis) > 0
          );

          if (song?.trackTimeMillis) {
            const durationMs = Math.round(Number(song.trackTimeMillis));
            await env.DB.prepare(`
              UPDATE tracks
              SET duration_ms=?, updated_at=CURRENT_TIMESTAMP
              WHERE id=? AND (duration_ms IS NULL OR duration_ms=0)
            `).bind(durationMs, trackId).run();
            track.duration_ms = durationMs;
            return track;
          }
        }
      } catch (error) {
        console.warn("Apple duration lookup failed", catalogId, error?.message || error);
      }
    }
  }

  // Deezer-backed imports are the normal representation produced by the
  // Apple import matcher. Use the actual Deezer recording duration rather
  // than refusing the acquisition merely because duration_ms was absent.
  if ((source === "deezer" || source === "apple") && rawSourceId) {
    const deezerId = rawSourceId.replace(/^deezer[-_:]/i, "");

    if (/^\d+$/.test(deezerId)) {
      try {
        const response = await fetch(
          `https://api.deezer.com/track/${encodeURIComponent(deezerId)}`,
          { headers: { Accept: "application/json" } }
        );

        if (response.ok) {
          const data = await response.json();
          const seconds = Number(data?.duration || 0);

          if (seconds > 0) {
            const durationMs = Math.round(seconds * 1000);
            await env.DB.prepare(`
              UPDATE tracks
              SET duration_ms=?, updated_at=CURRENT_TIMESTAMP
              WHERE id=? AND (duration_ms IS NULL OR duration_ms=0)
            `).bind(durationMs, trackId).run();
            track.duration_ms = durationMs;
            return track;
          }
        }
      } catch (error) {
        console.warn("Deezer duration lookup failed", deezerId, error?.message || error);
      }
    }
  }

  // Last provider lookup: if the source ID is unavailable or the provider
  // lookup failed, search Deezer using the already canonical title/artist.
  // This is only used to obtain duration; acquisition still validates the
  // downloaded recording independently.
  if (track.title && track.artist) {
    try {
      const url = new URL("https://api.deezer.com/search");
      url.searchParams.set("q", `${track.title} ${track.artist}`);
      url.searchParams.set("limit", "10");

      const response = await fetch(url, {
        headers: { Accept: "application/json" },
      });

      if (response.ok) {
        const data = await response.json();
        const title = String(track.title).toLowerCase().trim();
        const artist = String(track.artist).toLowerCase().trim();

        const match = (data.data || []).find(item =>
          String(item.title || "").toLowerCase().trim() === title &&
          String(item.artist?.name || "").toLowerCase().trim() === artist &&
          Number(item.duration || 0) > 0
        );

        if (match) {
          const durationMs = Math.round(Number(match.duration) * 1000);
          await env.DB.prepare(`
            UPDATE tracks
            SET duration_ms=?, updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND (duration_ms IS NULL OR duration_ms=0)
          `).bind(durationMs, trackId).run();
          track.duration_ms = durationMs;
          return track;
        }
      }
    } catch (error) {
      console.warn("Deezer title/artist duration lookup failed", trackId, error?.message || error);
    }
  }

  return track;
}'''

pattern = re.compile(
    r'async function resolveAppleDuration\(env, track, trackId\) \{.*?\n\}\n\n(?=async function dispatchWarm)',
    re.DOTALL,
)

s2, count = pattern.subn(replacement + "\n\n", s, count=1)
if count != 1:
    raise SystemExit("resolveAppleDuration function not found; refusing to modify entry.js")

p.write_text(s2)
print("Patched acquisition duration resolver for Apple + Deezer-backed tracks")

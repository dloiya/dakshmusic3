/*
 * On-device audio cache.
 *
 * Transparently caches full track responses in the Cache Storage API so
 * recently played songs are available instantly (and offline) without
 * re-fetching from the Worker/R2 every time. Capped at DEVICE_LIMIT tracks,
 * evicted FIFO -- strictly the oldest-inserted track evicted first,
 * regardless of how recently it's been replayed since. This is the same
 * eviction policy the server-side album cache uses, and unlike that one,
 * this cache is shared across every playback context (playlist, queue,
 * album, anywhere else audio gets played from) rather than being scoped
 * per-context.
 */

const CACHE_NAME = "device-audio-v1";
const DEVICE_LIMIT = 10;
const META_URL = "https://device-cache.local/__meta__";
const PLAYBACK_RE = /^\/api\/v1\/playback\/(\d+)$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function canonicalRequest(url) {
  return new Request(url.origin + url.pathname, { credentials: "include" });
}

async function getMeta(cache) {
  const res = await cache.match(META_URL);
  if (!res) return { order: [] };
  try { return await res.json(); } catch { return { order: [] }; }
}

async function setMeta(cache, meta) {
  await cache.put(META_URL, new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }));
}

async function recordInsertion(cache, trackId) {
  const meta = await getMeta(cache);
  if (!meta.order.includes(trackId)) {
    meta.order.push(trackId); // FIFO: newest goes to the back, oldest stays at the front
  }
  await setMeta(cache, meta);
  return meta;
}

async function evictOverLimit(cache, meta) {
  while (meta.order.length > DEVICE_LIMIT) {
    const evictedId = meta.order.shift(); // evict the oldest-inserted, not the least-recently-used
    try {
      await cache.delete(canonicalRequest(new URL(`${self.location.origin}/api/v1/playback/${evictedId}`)));
    } catch { /* best effort */ }
  }
  await setMeta(cache, meta);
}

async function cacheFullTrackInBackground(cache, fullReq, trackId, url) {
  try {
    // A separate request object carrying a marker header, so the server
    // can tell this background copy-for-caching fetch apart from the
    // real playback request and skip incrementing play_count for it --
    // otherwise every newly-cached track would silently count as two
    // plays instead of one.
    const warmReq = new Request(url.origin + url.pathname, {
      credentials: "include",
      headers: { "X-Cache-Warm": "1" },
    });
    const resp = await fetch(warmReq);
    if (!resp.ok) return;
    await cache.put(fullReq, resp.clone());
    const meta = await recordInsertion(cache, trackId);
    await evictOverLimit(cache, meta);
  } catch { /* best effort, offline or transient failure */ }
}

async function sliceForRange(fullResponse, rangeHeader) {
  const buf = await fullResponse.clone().arrayBuffer();
  const total = buf.byteLength;
  const contentType = fullResponse.headers.get("content-type") || "audio/flac";

  if (!rangeHeader) {
    return new Response(buf, {
      status: 200,
      headers: { "content-type": contentType, "content-length": String(total), "accept-ranges": "bytes" },
    });
  }

  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  const start = match ? parseInt(match[1], 10) : 0;
  const end = Math.min(match && match[2] ? parseInt(match[2], 10) : total - 1, total - 1);
  const chunk = buf.slice(start, end + 1);

  return new Response(chunk, {
    status: 206,
    headers: {
      "content-type": contentType,
      "content-range": `bytes ${start}-${end}/${total}`,
      "content-length": String(chunk.byteLength),
      "accept-ranges": "bytes",
    },
  });
}

async function handlePlayback(event, request, trackId, url) {
  const cache = await caches.open(CACHE_NAME);
  const fullReq = canonicalRequest(url);
  const cachedFull = await cache.match(fullReq);

  if (cachedFull) {
    return sliceForRange(cachedFull, request.headers.get("Range"));
  }

  event.waitUntil(cacheFullTrackInBackground(cache, fullReq, trackId, url));
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const m = url.pathname.match(PLAYBACK_RE);
  if (!m || event.request.method !== "GET") return;
  event.respondWith(handlePlayback(event, event.request, m[1], url));
});

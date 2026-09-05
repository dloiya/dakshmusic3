const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET,HEAD,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, Range",
    "access-control-expose-headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type",
    vary: "Origin",
  };
}

function json(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request) },
  });
}

function contentType(key) {
  const k = String(key).toLowerCase();
  if (k.endsWith(".mp3")) return "audio/mpeg";
  if (k.endsWith(".m4a")) return "audio/mp4";
  if (k.endsWith(".ogg")) return "audio/ogg";
  if (k.endsWith(".opus")) return "audio/opus";
  if (k.endsWith(".wav")) return "audio/wav";
  return "audio/flac";
}

function parseRange(value, size) {
  if (!value || !value.startsWith("bytes=")) return null;
  const first = value.slice(6).split(",", 1)[0].trim();
  const [a, b] = first.split("-", 2);
  let start;
  let end;
  if (a === "") {
    const suffix = Number(b);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Number(b);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

export async function handleStream(request, env, trackId) {
  const id = Number(trackId);
  if (!id || !env.AUDIO_BUCKET) return json({ error: "Audio storage is not configured" }, 503, request);

  const track = await env.DB.prepare(`SELECT storage_key,storage_status FROM tracks WHERE id=?`).bind(id).first();
  if (!track) return json({ error: "Track not found" }, 404, request);
  if (track.storage_status !== "available" || !track.storage_key) {
    return json({ error: "Track is not available in R2", storage_status: track.storage_status || "missing" }, 409, request);
  }

  const key = String(track.storage_key);
  const head = await env.AUDIO_BUCKET.head(key);
  if (!head) return json({ error: "Audio object not found in R2" }, 404, request);

  const size = Number(head.size || 0);
  const range = parseRange(request.headers.get("Range"), size);
  const object = await env.AUDIO_BUCKET.get(key, range ? { range: { offset: range.start, length: range.length } } : undefined);
  if (!object) return json({ error: "Audio object not found in R2" }, 404, request);

  const headers = {
    ...corsHeaders(request),
    "Accept-Ranges": "bytes",
    "Content-Type": object.httpMetadata?.contentType || contentType(key),
    "Content-Length": String(range ? range.length : size),
    "Cache-Control": "private, max-age=3600",
    ETag: object.httpEtag || head.httpEtag || "",
  };
  if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;

  return new Response(object.body, { status: range ? 206 : 200, headers });
}

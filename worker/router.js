import legacy from "./index.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(data, status = 200, request = null, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...(request ? corsHeaders(request) : {}), ...extra },
  });
}

function ociBase(env) {
  const value = env.OCI_API_URL?.trim();
  if (!value) throw new Error("OCI_API_URL is not configured");
  return value.replace(/\/$/, "");
}

async function ociRequest(request, env, path, init = {}) {
  const token = env.OCI_API_TOKEN;
  if (!token) throw new Error("OCI_API_TOKEN is not configured");

  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");

  const upstream = await fetch(`${ociBase(env)}${path}`, { ...init, headers });
  const text = await upstream.text();
  let data;
  try { data = JSON.parse(text); }
  catch { data = { detail: text || `OCI returned HTTP ${upstream.status}` }; }
  return json(data, upstream.status, request);
}

async function deezerSearch(request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 25), 1), 50);
  if (!query) return json({ error: "Missing q" }, 400, request);

  const deezerUrl = new URL("https://api.deezer.com/search");
  deezerUrl.searchParams.set("q", query);
  deezerUrl.searchParams.set("limit", String(limit));
  const upstream = await fetch(deezerUrl.toString(), { headers: { accept: "application/json" } });
  if (!upstream.ok) return json({ error: `Deezer search failed: HTTP ${upstream.status}` }, 502, request);
  const data = await upstream.json();
  if (data?.error) return json({ error: data.error.message || "Deezer search failed" }, 502, request);
  return json(data, 200, request, { "cache-control": "public, max-age=60, s-maxage=300" });
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  // Browser -> Cloudflare Worker -> Deezer.
  if (path === "/api/search" && request.method === "GET") {
    try { return await deezerSearch(request); }
    catch (error) {
      console.error("Deezer search error", error);
      return json({ error: error?.message || "Search failed" }, 502, request);
    }
  }

  // Browser -> Cloudflare Worker -> OCI FastAPI.
  // OCI_API_TOKEN stays inside the Worker and is never exposed to the browser.
  if (path === "/api/start" && request.method === "POST") {
    try {
      return await ociRequest(request, env, "/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      console.error("OCI /start error", error);
      return json({ error: error?.message || "OCI unavailable" }, 502, request);
    }
  }

  // POST /api/acquire/<encoded source URL>
  // -> POST <OCI_API_URL>/acquire/<encoded source URL>
  const prefix = "/api/acquire/";
  if (path.startsWith(prefix) && request.method === "POST") {
    try {
      const encoded = path.slice(prefix.length);
      if (!encoded) return json({ error: "Missing source URL" }, 400, request);
      decodeURIComponent(encoded); // validate URL encoding
      return await ociRequest(request, env, `/acquire/${encoded}`, { method: "POST" });
    } catch (error) {
      console.error("OCI /acquire error", error);
      return json({ error: error?.message || "OCI acquisition failed" }, 502, request);
    }
  }

  return legacy.fetch(request, env, ctx);
}

export default { async fetch(request, env, ctx) { return handle(request, env, ctx); } };

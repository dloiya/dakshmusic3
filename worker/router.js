import legacy from "./index.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

async function deezerSearch(request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 25), 1), 50);

  if (!query) return json({ error: "Missing q" }, 400);

  const deezerUrl = new URL("https://api.deezer.com/search");
  deezerUrl.searchParams.set("q", query);
  deezerUrl.searchParams.set("limit", String(limit));

  const upstream = await fetch(deezerUrl.toString(), {
    headers: { "accept": "application/json" },
  });

  if (!upstream.ok) {
    return json(
      { error: `Deezer search failed: HTTP ${upstream.status}` },
      502,
    );
  }

  const data = await upstream.json();
  if (data?.error) {
    return json({ error: data.error.message || "Deezer search failed" }, 502);
  }

  return json(data, 200, {
    "cache-control": "public, max-age=60, s-maxage=300",
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/search" && request.method === "GET") {
      try {
        return await deezerSearch(request);
      } catch (error) {
        console.error("Deezer search error", error);
        return json({ error: error?.message || "Search failed" }, 502);
      }
    }

    return legacy.fetch(request, env, ctx);
  },
};

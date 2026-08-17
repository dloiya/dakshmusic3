import entry from "./entry.js";
import { handleLibraryV3 } from "./library.js";
import { backfillMissingMetadata } from "./metadata_backfill.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function authenticated(env, request) {
  const token = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)music_session=([^;]+)/)?.[1];
  if (!token) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
  return !!await env.DB.prepare(`SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?`).bind(hash, Math.floor(Date.now() / 1000)).first();
}

async function clearAllViaEntry(request, env, ctx) {
  // Keep the canonical implementation in entry.js. This explicit delegation
  // guarantees that the route is handled before library/asset routing.
  return entry.fetch(request, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/v1/admin/clear-all" && request.method === "POST") {
      return clearAllViaEntry(request, env, ctx);
    }

    if (url.pathname === "/api/v1/apple-music/import" && request.method === "POST") return json({ ok: true, deferred: true, message: "Library import is handled by /library/seed" });
    if (url.pathname === "/api/v1/library/backfill-metadata" && request.method === "POST") {
      if (!(await authenticated(env, request))) return json({ error: "Authentication required" }, 401);
      const result = await backfillMissingMetadata(env, { limit: 20, concurrency: 6 });
      const remaining = await env.DB.prepare(`SELECT COUNT(*) AS count FROM tracks WHERE duration_ms IS NULL OR duration_ms<=0 OR artwork_url IS NULL OR artwork_url=''`).first();
      return json({ ok: true, metadata_backfill: { ...result, remaining: Number(remaining?.count || 0), batch_limit: 20 } });
    }
    const library = await handleLibraryV3(request, env);
    if (library) return library;
    return entry.fetch(request, env, ctx);
  },
  async scheduled(controller, env) {
    try { console.log("Scheduled metadata backfill", controller.cron, await backfillMissingMetadata(env, { limit: 20, concurrency: 4 })); }
    catch (error) { console.error("Scheduled metadata backfill failed", error?.stack || error); }
  },
};

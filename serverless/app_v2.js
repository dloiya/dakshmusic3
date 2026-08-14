import entry from "./entry.js";
import { handleLibraryRoute } from "./library.js";
import { handleLibraryV2, scheduled as libraryScheduled } from "./library_v2.js";
import { handleAcquisitionV3 } from "./acquisition_v3.js";
import { backfillMissingMetadata } from "./metadata_backfill.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/apple-music/import" && request.method === "POST") {
      return json({ ok: true, deferred: true, message: "Library import is handled by /library/seed" });
    }

    if (url.pathname === "/api/v1/library/backfill-metadata" && request.method === "POST") {
      const token = (request.headers.get("Cookie") || "").match(/(?:^|;\\s*)music_session=([^;]+)/)?.[1];
      if (!token) return json({ error: "Authentication required" }, 401);
      const cryptoHash = async text => {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
      };
      const session = await env.DB.prepare(`SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?`)
        .bind(await cryptoHash(token), Math.floor(Date.now() / 1000)).first();
      if (!session) return json({ error: "Authentication required" }, 401);
      const result = await backfillMissingMetadata(env, { limit: 500, concurrency: 4 });
      return json({ ok: true, metadata_backfill: result });
    }

    // Keep acquisition ahead of the legacy worker route so Apple imports with
    // missing duration_ms are resolved from the catalog before dispatch.
    const acquisition = await handleAcquisitionV3(request, env);
    if (acquisition) return acquisition;

    const v2 = await handleLibraryV2(request, env, ctx);
    if (v2) return v2;
    const handled = await handleLibraryRoute(request, env, ctx);
    if (handled) return handled;
    return entry.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(libraryScheduled(env));
  },
};

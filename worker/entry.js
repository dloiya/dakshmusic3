import router from "./router.js";
import { handleAcquisition, handlePlayTrack, handlePlayAlbum, reconcileAcquisitions } from "./acquisition.js";

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "storage_status") {
      out[key] = item === "queued" ? "downloading"
        : item === "available" ? "ready"
        : item;
    } else {
      out[key] = normalizeValue(item);
    }
  }
  return out;
}

function wrapStatement(statement) {
  return new Proxy(statement, {
    get(target, property) {
      if (property === "__dakshmusic3Raw") return target;
      const value = target[property];
      if (property === "bind") return (...args) => wrapStatement(value.apply(target, args));
      if (["run", "first", "all", "raw"].includes(property)) {
        return async (...args) => normalizeValue(await value.apply(target, args));
      }
      if (typeof value !== "function") return value;
      return value.bind(target);
    },
  });
}

function unwrapStatement(statement) {
  return statement?.__dakshmusic3Raw || statement;
}

function wrapDb(db) {
  if (!db) return db;
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql) => wrapStatement(target.prepare(sql));
      if (property === "batch") {
        return async (statements) => normalizeValue(await target.batch(statements.map(unwrapStatement)));
      }
      const value = target[property];
      if (typeof value !== "function") return value;
      return value.bind(target);
    },
  });
}

function adaptEnv(env) {
  if (!env?.DB) return env;
  return { ...env, DB: wrapDb(env.DB) };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/g, "") || "/";

    // Acquisition/playback uses the raw D1 binding so internal state remains the
    // database vocabulary (queued/available). API response normalization stays
    // isolated to the legacy catalog router.
    if (path === "/api/acquisition" && request.method === "POST") {
      return handleAcquisition(request, env, ctx);
    }
    if (path === "/api/play/track" && request.method === "POST") {
      try { return await handlePlayTrack(request, env, ctx); }
      catch (err) {
        console.error("Play track failed", err);
        return new Response(JSON.stringify({ error: String(err?.message || err) }), {
          status: 500, headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }
    const albumMatch = path.match(/^\/api\/play\/album\/(\d+)$/);
    if (albumMatch && request.method === "POST") {
      try { return await handlePlayAlbum(request, env, albumMatch[1], ctx); }
      catch (err) {
        console.error("Play album failed", err);
        return new Response(JSON.stringify({ error: String(err?.message || err) }), {
          status: 500, headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    return router.fetch(request, adaptEnv(env), ctx);
  },

  async scheduled(controller, env, ctx) {
    try {
      await reconcileAcquisitions(env.DB);
    } catch (err) {
      console.error("Acquisition reconciliation failed", err);
    }
    try {
      if (typeof router.scheduled === "function") {
        return await router.scheduled(controller, adaptEnv(env), ctx);
      }
    } catch (err) {
      console.error("Scheduled watchdog failed", err);
    }
  },
};

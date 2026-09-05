import router from "./router.js";

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
      const value = target[property];

      if (property === "bind") {
        return (...args) => wrapStatement(value.apply(target, args));
      }

      if (["run", "first", "all", "raw"].includes(property)) {
        return async (...args) => normalizeValue(await value.apply(target, args));
      }

      if (typeof value !== "function") return value;
      return value.bind(target);
    },
  });
}

function wrapDb(db) {
  if (!db) return db;

  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql) => wrapStatement(target.prepare(sql));
      }

      if (property === "batch") {
        return async (statements) => {
          const raw = statements.map((statement) => statement?.__dakshmusic3Raw || statement);
          return normalizeValue(await target.batch(raw));
        };
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
    return router.fetch(request, adaptEnv(env), ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof router.scheduled === "function") {
      return router.scheduled(controller, adaptEnv(env), ctx);
    }
  },
};

import router from "./router.js";

/**
 * Keep the Worker API compatible with the existing D1 storage_status enum.
 *
 * D1 accepts only: missing, queued, available, failed.
 * Older router/frontend code uses: missing, downloading, ready, failed.
 * Translate SQL writes to the real enum and normalize returned rows back to
 * the API vocabulary expected by the UI.
 */
const DB_STATUS_WRITE = [
  [/'downloading'/g, "'queued'"],
  [/'ready'/g, "'available'"],
];

function rewriteSql(sql) {
  let value = String(sql);
  for (const [pattern, replacement] of DB_STATUS_WRITE) {
    value = value.replace(pattern, replacement);
  }
  return value;
}

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

function wrapStatement(statement, statementMap) {
  const proxy = new Proxy(statement, {
    get(target, property) {
      const value = target[property];

      if (property === "bind") {
        return (...args) => wrapStatement(value.apply(target, args), statementMap);
      }

      if (["run", "first", "all", "raw"].includes(property)) {
        return async (...args) => normalizeValue(await value.apply(target, args));
      }

      if (typeof value !== "function") return value;
      return value.bind(target);
    },
  });
  statementMap.set(proxy, statement);
  return proxy;
}

function wrapDb(db) {
  if (!db) return db;

  const statementMap = new WeakMap();
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql) => wrapStatement(target.prepare(rewriteSql(sql)), statementMap);
      }

      if (property === "batch") {
        return async (statements) => {
          const raw = statements.map((statement) => statementMap.get(statement) || statement);
          return target.batch(raw);
        };
      }

      const value = target[property];
      if (typeof value !== "function") return value;
      return value.bind(target);
    },
  });

  return proxy;
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

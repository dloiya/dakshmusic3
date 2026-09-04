import router from "./router.js";

/**
 * Worker runtime entrypoint.
 *
 * HTTP API routing lives exclusively in router.js.
 * Background acquisition is handled by the router's acquisition flow.
 * Scheduled work is delegated to the router.
 */
export default {
  async fetch(request, env, ctx) {
    return router.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof router.scheduled === "function") {
      return router.scheduled(controller, env, ctx);
    }
  },
};

import entry from "./entry.js";
import { handleLibraryRoute } from "./library.js";

export default {
  async fetch(request, env, ctx) {
    const handled = await handleLibraryRoute(request, env, ctx);
    if (handled) return handled;
    return entry.fetch(request, env, ctx);
  },
};

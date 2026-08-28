export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (!env.COORDINATOR || typeof env.COORDINATOR.fetch !== 'function') {
        return new Response(JSON.stringify({ error: 'Coordinator service binding is unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return env.COORDINATOR.fetch(request);
    }

    if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
      return new Response('Static assets binding is unavailable', { status: 503 });
    }

    return env.ASSETS.fetch(request);
  },
};

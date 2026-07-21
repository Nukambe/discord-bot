/**
 * Adds two routes to Vite's own server (dev and preview), so no separate
 * HTTP server/framework is needed:
 *   GET /events        - SSE stream the React app subscribes to
 *   GET /events/push    - the bot process calls this to broadcast an event
 *                          (?type=<name>&data=<url-encoded JSON>)
 *
 * Each event payload is treated as the full current state for its type (not
 * a delta), so the last payload per type is replayed to newly-subscribed
 * clients — a browser refresh doesn't lose the current recent/queue/chat state.
 */
export function eventsPlugin() {
  const clients = new Set();
  const lastByType = new Map();

  function broadcast(type, data) {
    lastByType.set(type, data);
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  function handleEvents(req, res, next) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      for (const [type, data] of lastByType) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/events/push' && req.method === 'GET') {
      const type = url.searchParams.get('type') || 'message';
      let data = {};
      try {
        data = JSON.parse(url.searchParams.get('data') || '{}');
      } catch {
        // malformed payload, broadcast empty object
      }
      broadcast(type, data);
      res.writeHead(204);
      res.end();
      return;
    }

    next();
  }

  return {
    name: 'twitch-bot-events',
    configureServer(server) {
      server.middlewares.use(handleEvents);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleEvents);
    },
  };
}

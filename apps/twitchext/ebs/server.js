import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseSnapshot, PROTOCOL_VERSION } from '../shared/protocol.js';
import { decodeSecret, secretMatches, verifyViewerToken } from './auth.js';
import { createStore } from './store.js';
import { createPubSub } from './pubsub.js';

const ITEMS_PATH = fileURLToPath(new URL('../data/items.json', import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Extension Backend Service.
 *
 * Two audiences with very different trust levels:
 *  - the companion app  — one writer, authenticated by a shared secret.
 *  - extension viewers  — many readers, authenticated by Twitch-signed JWTs.
 *
 * The channel a reader gets is taken from their JWT, so a viewer cannot read a
 * channel they aren't watching by editing a query parameter.
 */
export async function createEbs({
  secret,
  companionSecret,
  clientId,
  ownerId,
  allowedOrigins,
  pubsubEnabled = true,
}) {
  const extSecret = decodeSecret(secret);
  const store = createStore();
  const pubsub = createPubSub({ clientId, secret: extSecret, ownerId, enabled: pubsubEnabled });

  // Loaded once at boot; the item DB only changes when the streamer re-learns
  // items, which is a companion-side action followed by a redeploy.
  let itemDb = JSON.parse(await readFile(ITEMS_PATH, 'utf8'));
  let publicItems = toPublicItems(itemDb);

  const sweeper = setInterval(() => store.sweep(), 60_000);
  sweeper.unref?.();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    applyCors(req, res, allowedOrigins);

    if (req.method === 'OPTIONS') return send(res, 204, null);

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          ok: true,
          protocol: PROTOCOL_VERSION,
          channels: store.channelCount,
          pubsub: pubsub.enabled,
          itemsVersion: itemDb.version,
        });
      }

      // Item copy is not secret and is identical for every viewer, so it is
      // served unauthenticated and cached hard — it's the largest payload the
      // frontend fetches and it changes maybe once a patch.
      if (req.method === 'GET' && url.pathname === '/api/items') {
        res.setHeader('cache-control', 'public, max-age=300');
        return json(res, 200, { version: itemDb.version, items: publicItems });
      }

      if (req.method === 'POST' && url.pathname === '/api/snapshot') {
        return await handleSnapshot(req, res);
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return handleState(req, res, url);
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('EBS error:', err);
      return json(res, 500, { error: 'internal error' });
    }
  });

  return { server, store, pubsub, reloadItems };

  async function handleSnapshot(req, res) {
    const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secretMatches(provided, companionSecret)) {
      return json(res, 401, { error: 'bad companion secret' });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return json(res, 400, { error: `invalid JSON: ${err.message}` });
    }

    const channelId = String(body.channelId || '');
    if (!/^\d+$/.test(channelId)) {
      return json(res, 400, { error: 'channelId must be a numeric Twitch channel id' });
    }

    let snapshot;
    try {
      snapshot = parseSnapshot(body);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }

    // A companion whose clock is off would break delay compensation for every
    // viewer, in a way that looks like "the extension is just broken".
    const skew = Math.abs(Date.now() - snapshot.capturedAt);
    if (skew > 30_000) {
      return json(res, 400, {
        error: `capturedAt is ${Math.round(skew / 1000)}s from server time — check the companion machine's clock`,
      });
    }

    store.put(channelId, snapshot);
    pubsub.publish(channelId, snapshot).catch(() => {}); // best effort, never blocks the writer

    return json(res, 202, { ok: true });
  }

  function handleState(req, res, url) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return json(res, 401, { error: 'missing extension JWT' });

    let viewer;
    try {
      viewer = verifyViewerToken(token, extSecret);
    } catch (err) {
      return json(res, 401, { error: err.message });
    }

    const since = Number(url.searchParams.get('since')) || 0;
    const state = store.get(viewer.channelId, since);

    // No caching: this is the live path, and a proxy holding it for even a
    // second would put tooltips behind where the viewer is looking.
    res.setHeader('cache-control', 'no-store');
    return json(res, 200, {
      serverTime: Date.now(), // lets the frontend correct for client clock skew
      itemsVersion: itemDb.version,
      frame: state.frame,
      snapshots: state.snapshots,
    });
  }

  async function reloadItems() {
    itemDb = JSON.parse(await readFile(ITEMS_PATH, 'utf8'));
    publicItems = toPublicItems(itemDb);
    return itemDb.version;
  }
}

/** Fingerprints are companion-side data and would triple the payload. */
function toPublicItems(db) {
  const out = {};
  for (const [id, item] of Object.entries(db.items || {})) {
    out[id] = { name: item.name, lines: item.lines || [] };
  }
  return out;
}

function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  // Extension frontends are served from https://<client-id>.ext-twitch.tv, and
  // the developer rig from localhost — anything else has no business here.
  if (origin && allowedOrigins.some(rule => matchOrigin(rule, origin))) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-max-age', '86400');

  // Private Network Access. The extension page is served from a public origin
  // (ext-twitch.tv) but this EBS listens on a private/loopback address, so
  // Chrome sends a preflight asking permission to cross that boundary. Without
  // this header the browser blocks every request and the overlay silently shows
  // nothing. Only relevant because the EBS runs on the streamer's own machine.
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('access-control-allow-private-network', 'true');
  }
}

function matchOrigin(rule, origin) {
  if (rule === '*') return true;
  if (rule.startsWith('*.')) return origin.endsWith(rule.slice(1));
  return rule === origin;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  send(res, status, JSON.stringify(payload), 'application/json');
}

function send(res, status, body, contentType) {
  if (contentType) res.setHeader('content-type', contentType);
  res.writeHead(status);
  res.end(body);
}

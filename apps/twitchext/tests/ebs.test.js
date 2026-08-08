import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createEbs } from '../ebs/server.js';
import { createStore } from '../ebs/store.js';
import { verifyViewerToken, decodeSecret, secretMatches } from '../ebs/auth.js';
import { parseSnapshot, gameToStream } from '../shared/protocol.js';

const SECRET_B64 = Buffer.from('test-extension-secret-0123456789').toString('base64');
const SECRET = decodeSecret(SECRET_B64);
const COMPANION_SECRET = 'companion-shared-secret';

function mintToken(payload, secret = SECRET) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, channel_id: '12345', role: 'viewer', ...payload })
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

async function startEbs() {
  const { server } = await createEbs({
    secret: SECRET_B64,
    companionSecret: COMPANION_SECRET,
    clientId: 'testclient',
    ownerId: '999',
    allowedOrigins: ['https://testclient.ext-twitch.tv'],
    pubsubEnabled: false,
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(resolve => server.close(resolve)) };
}

// --- auth ---

test('a valid viewer token yields its channel id', () => {
  const claims = verifyViewerToken(mintToken({}), SECRET);
  assert.equal(claims.channelId, '12345');
});

test('a token signed with the wrong secret is rejected', () => {
  const forged = mintToken({}, Buffer.from('not-the-real-secret'));
  assert.throws(() => verifyViewerToken(forged, SECRET), /signature/);
});

test('an expired token is rejected', () => {
  const stale = mintToken({ exp: Math.floor(Date.now() / 1000) - 10 });
  assert.throws(() => verifyViewerToken(stale, SECRET), /expired/);
});

test('the "none" algorithm is rejected', () => {
  // Classic JWT downgrade: strip the signature and claim no algorithm.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, channel_id: '99999' })
  ).toString('base64url');
  assert.throws(() => verifyViewerToken(`${header}.${body}.`, SECRET), /alg/);
});

test('companion secret comparison rejects wrong values and lengths', () => {
  assert.equal(secretMatches(COMPANION_SECRET, COMPANION_SECRET), true);
  assert.equal(secretMatches('short', COMPANION_SECRET), false);
  assert.equal(secretMatches('', COMPANION_SECRET), false);
  assert.equal(secretMatches(undefined, COMPANION_SECRET), false);
});

// --- protocol ---

test('parseSnapshot clamps coordinates and drops junk', () => {
  const snap = parseSnapshot({
    capturedAt: Date.now(),
    items: [{ id: 'frog', x: -0.5, y: 1.4, w: 0.1, h: 0.1, score: 0.9123456 }],
    frame: { x: 0.25, y: 0, w: 0.5, h: 1 },
  });

  assert.equal(snap.items[0].x, 0);
  assert.equal(snap.items[0].y, 1);
  assert.equal(snap.items[0].score, 0.912);
  assert.equal(snap.frame.w, 0.5);
});

test('parseSnapshot rejects malformed input', () => {
  assert.throws(() => parseSnapshot({ items: [] }), /capturedAt/);
  assert.throws(() => parseSnapshot({ capturedAt: 1, items: 'nope' }), /items/);
  assert.throws(() => parseSnapshot({ capturedAt: 1, items: [{ x: 0, y: 0, w: 1, h: 1 }] }), /id/);
  assert.throws(() => parseSnapshot({ capturedAt: 1, items: [{ id: 'a', x: 0, y: 0, w: 0, h: 1 }] }), /rect/);
});

test('gameToStream applies the letterbox offset', () => {
  // Emulator occupying the middle half of a 16:9 canvas.
  const frame = { x: 0.25, y: 0, w: 0.5, h: 1 };
  const mapped = gameToStream({ x: 0.5, y: 0.8, w: 0.1, h: 0.1 }, frame);

  assert.equal(mapped.x, 0.5);
  assert.equal(mapped.w, 0.05);
  assert.equal(mapped.y, 0.8);
});

// --- store / delay compensation ---

test('store returns the snapshot that was current at a past moment', () => {
  const store = createStore();
  const now = Date.now();

  store.put('1', { capturedAt: now - 10_000, items: [{ id: 'old' }], frame: { x: 0, y: 0, w: 1, h: 1 } });
  store.put('1', { capturedAt: now - 5_000, items: [{ id: 'mid' }], frame: null });
  store.put('1', { capturedAt: now - 250, items: [{ id: 'new' }], frame: null });

  const { snapshots } = store.get('1');
  assert.equal(snapshots.length, 3);

  // Emulates the frontend's lookup for an 8s broadcast delay.
  const target = now - 8000;
  const chosen = snapshots.filter(s => s.t <= target).at(-1);
  assert.equal(chosen.items[0].id, 'old');
});

test('store re-sorts snapshots that arrive out of order', () => {
  const store = createStore();
  const now = Date.now();

  store.put('1', { capturedAt: now - 1000, items: [{ id: 'a' }], frame: null });
  store.put('1', { capturedAt: now - 3000, items: [{ id: 'b' }], frame: null });

  const times = store.get('1').snapshots.map(s => s.t);
  assert.deepEqual(times, [...times].sort((x, y) => x - y));
});

test('store isolates channels from each other', () => {
  const store = createStore();
  store.put('1', { capturedAt: Date.now(), items: [{ id: 'a' }], frame: null });

  assert.equal(store.get('2').snapshots.length, 0);
  assert.equal(store.get('1').snapshots.length, 1);
});

// --- http surface ---

test('EBS accepts a companion snapshot and serves it to an authorized viewer', async () => {
  const { base, close } = await startEbs();

  try {
    const post = await fetch(`${base}/api/snapshot`, {
      method: 'POST',
      headers: { authorization: `Bearer ${COMPANION_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        channelId: '12345',
        capturedAt: Date.now(),
        items: [{ id: 'frog', x: 0.1, y: 0.8, w: 0.07, h: 0.12 }],
        frame: { x: 0.25, y: 0, w: 0.5, h: 1 },
      }),
    });
    assert.equal(post.status, 202);

    const res = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${mintToken({})}` } });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.snapshots.length, 1);
    assert.equal(body.snapshots[0].items[0].id, 'frog');
    assert.equal(body.frame.w, 0.5);
    assert.ok(Math.abs(body.serverTime - Date.now()) < 5000);
  } finally {
    await close();
  }
});

test('a viewer cannot read a channel their token is not for', async () => {
  const { base, close } = await startEbs();

  try {
    await fetch(`${base}/api/snapshot`, {
      method: 'POST',
      headers: { authorization: `Bearer ${COMPANION_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: '12345', capturedAt: Date.now(), items: [{ id: 'frog', x: 0, y: 0, w: 1, h: 1 }] }),
    });

    // Token is for a different channel; the query string must not override it.
    const token = mintToken({ channel_id: '67890' });
    const res = await fetch(`${base}/api/state?channelId=12345`, { headers: { authorization: `Bearer ${token}` } });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).snapshots.length, 0);
  } finally {
    await close();
  }
});

test('EBS rejects snapshots without the companion secret', async () => {
  const { base, close } = await startEbs();

  try {
    const res = await fetch(`${base}/api/snapshot`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: '12345', capturedAt: Date.now(), items: [] }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('EBS rejects state requests with no token', async () => {
  const { base, close } = await startEbs();

  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
  } finally {
    await close();
  }
});

test('EBS rejects a snapshot whose clock is badly skewed', async () => {
  const { base, close } = await startEbs();

  try {
    const res = await fetch(`${base}/api/snapshot`, {
      method: 'POST',
      headers: { authorization: `Bearer ${COMPANION_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: '12345', capturedAt: Date.now() - 120_000, items: [] }),
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /clock/);
  } finally {
    await close();
  }
});

test('item copy is public but fingerprints never leave the companion', async () => {
  const { base, close } = await startEbs();

  try {
    const res = await fetch(`${base}/api/items`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.items.frog, 'seeded items should be served');
    assert.ok(Array.isArray(body.items.frog.lines));
    assert.equal(body.items.frog.fingerprints, undefined, 'fingerprints must not be exposed');
  } finally {
    await close();
  }
});

test('CORS is granted to the extension origin and withheld from others', async () => {
  const { base, close } = await startEbs();

  try {
    const allowed = await fetch(`${base}/health`, { headers: { origin: 'https://testclient.ext-twitch.tv' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://testclient.ext-twitch.tv');

    const denied = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally {
    await close();
  }
});

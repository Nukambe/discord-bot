import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FP_LEN,
  decodeFingerprint,
  encodeFingerprint,
  fingerprintRegion,
  similarity,
} from '../companion/vision/fingerprint.js';
import { createMatcher, createSlotSmoother } from '../companion/vision/matcher.js';
import { parseScreencap } from '../companion/capture/adb.js';

/** Builds a synthetic RGBA frame; `paint(x, y)` returns [r, g, b]. */
function makeFrame(width, height, paint) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const checker = (cell, tint) => (x, y) =>
  ((x / cell) | 0) % 2 === ((y / cell) | 0) % 2 ? tint : [20, 20, 20];

test('fingerprint is stable and unit-length', () => {
  const frame = makeFrame(64, 64, checker(8, [200, 40, 40]));
  const a = fingerprintRegion(frame, { x: 0, y: 0, w: 64, h: 64 });
  const b = fingerprintRegion(frame, { x: 0, y: 0, w: 64, h: 64 });

  assert.equal(a.length, FP_LEN);
  assert.equal(similarity(a, b), similarity(a, a));
  assert.ok(Math.abs(similarity(a, a) - 1) < 1e-5, 'self-similarity should be 1');
});

test('fingerprint separates different icons', () => {
  const red = fingerprintRegion(makeFrame(64, 64, checker(8, [200, 40, 40])), { x: 0, y: 0, w: 64, h: 64 });
  const blue = fingerprintRegion(makeFrame(64, 64, checker(8, [40, 40, 200])), { x: 0, y: 0, w: 64, h: 64 });
  const stripes = fingerprintRegion(
    makeFrame(64, 64, (x, y) => (y % 16 < 8 ? [200, 40, 40] : [20, 20, 20])),
    { x: 0, y: 0, w: 64, h: 64 }
  );

  assert.ok(similarity(red, blue) < 0.9, `colour should separate icons (got ${similarity(red, blue)})`);
  assert.ok(similarity(red, stripes) < 0.9, `shape should separate icons (got ${similarity(red, stripes)})`);
});

test('mean-centering survives a brightness shift', () => {
  // The emulator dimming between scenes must not break recognition.
  const normal = fingerprintRegion(makeFrame(64, 64, checker(8, [200, 40, 40])), { x: 0, y: 0, w: 64, h: 64 });
  const dim = fingerprintRegion(
    makeFrame(64, 64, (x, y) => checker(8, [200, 40, 40])(x, y).map(c => Math.round(c * 0.6))),
    { x: 0, y: 0, w: 64, h: 64 }
  );

  assert.ok(similarity(normal, dim) > 0.99, `dimmed icon should still match (got ${similarity(normal, dim)})`);
});

test('fingerprint encoding survives a round trip', () => {
  const vec = fingerprintRegion(makeFrame(64, 64, checker(8, [200, 40, 40])), { x: 0, y: 0, w: 64, h: 64 });
  const restored = decodeFingerprint(encodeFingerprint(vec));

  // Quantizing to int8 costs a little precision but must stay well above threshold.
  assert.ok(similarity(vec, restored) > 0.99, `quantization lost too much (got ${similarity(vec, restored)})`);
});

test('fingerprintRegion clamps rects that fall outside the frame', () => {
  const frame = makeFrame(32, 32, checker(4, [200, 40, 40]));
  assert.doesNotThrow(() => fingerprintRegion(frame, { x: 28, y: 28, w: 40, h: 40 }));
  assert.doesNotThrow(() => fingerprintRegion(frame, { x: -10, y: -10, w: 20, h: 20 }));
});

test('matcher identifies a known item and rejects an unknown one', () => {
  const frog = fingerprintRegion(makeFrame(64, 64, checker(8, [200, 40, 40])), { x: 0, y: 0, w: 64, h: 64 });
  const duck = fingerprintRegion(makeFrame(64, 64, checker(8, [40, 200, 40])), { x: 0, y: 0, w: 64, h: 64 });

  const matcher = createMatcher({
    items: {
      frog: { fingerprints: [encodeFingerprint(frog)] },
      duck: { fingerprints: [encodeFingerprint(duck)] },
    },
  });

  assert.equal(matcher.match(frog)?.id, 'frog');
  assert.equal(matcher.match(duck)?.id, 'duck');

  const noise = fingerprintRegion(
    makeFrame(64, 64, (x, y) => [(x * 7) % 256, (y * 13) % 256, (x * y) % 256]),
    { x: 0, y: 0, w: 64, h: 64 }
  );
  assert.equal(matcher.match(noise), null, 'unknown icon must not produce a tooltip');
});

test('matcher refuses to choose between near-identical items', () => {
  const base = fingerprintRegion(makeFrame(64, 64, checker(8, [200, 40, 40])), { x: 0, y: 0, w: 64, h: 64 });
  const nearly = fingerprintRegion(
    makeFrame(64, 64, (x, y) => (x === 0 && y === 0 ? [0, 0, 0] : checker(8, [200, 40, 40])(x, y))),
    { x: 0, y: 0, w: 64, h: 64 }
  );

  const matcher = createMatcher({
    items: {
      tier1: { fingerprints: [encodeFingerprint(base)] },
      tier2: { fingerprints: [encodeFingerprint(nearly)] },
    },
  });

  // Showing the wrong tier's tooltip is worse than showing none.
  assert.equal(matcher.match(base), null);
});

test('multiple fingerprints of one item do not suppress each other', () => {
  const a = fingerprintRegion(makeFrame(64, 64, checker(8, [200, 40, 40])), { x: 0, y: 0, w: 64, h: 64 });
  const b = fingerprintRegion(
    makeFrame(64, 64, (x, y) => (x === 0 && y === 0 ? [0, 0, 0] : checker(8, [200, 40, 40])(x, y))),
    { x: 0, y: 0, w: 64, h: 64 }
  );

  // Same item learned twice (two animation frames) must still match confidently.
  const matcher = createMatcher({ items: { frog: { fingerprints: [encodeFingerprint(a), encodeFingerprint(b)] } } });
  assert.equal(matcher.match(a)?.id, 'frog');
});

test('matcher reports a helpful error when nothing has been learned', () => {
  assert.throws(() => createMatcher({ items: { frog: { fingerprints: [] } } }), /twitchext:learn/);
});

test('smoother suppresses single-frame flicker', () => {
  const smoother = createSlotSmoother({ stability: 3 });

  assert.equal(smoother.push('item1', 'frog'), null);
  assert.equal(smoother.push('item1', 'frog'), null);
  assert.equal(smoother.push('item1', 'frog'), 'frog');

  // One dropped frame must not clear the tooltip.
  assert.equal(smoother.push('item1', null), 'frog');
  assert.equal(smoother.push('item1', 'frog'), 'frog');

  // A sustained change does take effect.
  assert.equal(smoother.push('item1', 'duck'), 'frog');
  assert.equal(smoother.push('item1', 'duck'), 'frog');
  assert.equal(smoother.push('item1', 'duck'), 'duck');
});

test('screencap parser handles both header layouts', () => {
  const pixels = Buffer.alloc(2 * 2 * 4, 0x7f);

  const legacy = Buffer.alloc(12);
  legacy.writeUInt32LE(2, 0);
  legacy.writeUInt32LE(2, 4);
  legacy.writeUInt32LE(1, 8);
  assert.equal(parseScreencap(Buffer.concat([legacy, pixels])).width, 2);

  // Android 9+ adds a colorspace field before the pixel data.
  const modern = Buffer.concat([legacy, Buffer.alloc(4)]);
  const parsed = parseScreencap(Buffer.concat([modern, pixels]));
  assert.equal(parsed.height, 2);
  assert.equal(parsed.data.length, 16);
});

test('screencap parser rejects a truncated frame', () => {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(64, 0);
  header.writeUInt32LE(64, 4);
  header.writeUInt32LE(1, 8);
  assert.throws(() => parseScreencap(Buffer.concat([header, Buffer.alloc(100)])), /payload/);
});

import 'dotenv/config';
import { captureFrame, listDevices } from './capture/adb.js';
import { fingerprintRegion } from './vision/fingerprint.js';
import { createMatcher, createSlotSmoother } from './vision/matcher.js';
import { loadItems, loadLayout, slotToCapturePixels } from './layout.js';
import { createUploader } from './uploader.js';

/**
 * Companion app — runs on the streamer's PC next to the emulator.
 *
 * Loop: grab a frame over adb, crop each configured item slot, fingerprint it,
 * match against the learned item set, smooth across frames, and POST the result
 * to the EBS. Everything downstream is just plumbing; this is the only part that
 * has to look at pixels.
 */

const FPS = Number(process.env.TWITCHEXT_CAPTURE_FPS) || 4;
const EBS_URL = process.env.TWITCHEXT_EBS_URL || 'http://127.0.0.1:8080';
const SECRET = process.env.TWITCHEXT_COMPANION_SECRET;
const CHANNEL_ID = process.env.TWITCHEXT_CHANNEL_ID;

if (!SECRET) throw new Error('Missing TWITCHEXT_COMPANION_SECRET in environment');
if (!CHANNEL_ID) throw new Error('Missing TWITCHEXT_CHANNEL_ID in environment');

const layout = await loadLayout();
const itemDb = await loadItems();
const matcher = createMatcher(itemDb, {
  minScore: Number(process.env.TWITCHEXT_MIN_SCORE) || 0.86,
  minMargin: Number(process.env.TWITCHEXT_MIN_MARGIN) || 0.03,
});
const smoother = createSlotSmoother({ stability: Number(process.env.TWITCHEXT_STABILITY) || 3 });
const uploader = createUploader({ ebsUrl: EBS_URL, secret: SECRET, channelId: CHANNEL_ID });

if (!layout.calibrated) {
  console.warn(
    '⚠️  layout.json is still the placeholder (calibrated: false). Slot rects almost\n' +
      '    certainly do not line up with your emulator — run `npm run twitchext:calibrate`.'
  );
}

const devices = await listDevices();
if (!devices.length) throw new Error('No adb devices. Is the emulator running, and `adb connect`ed?');
const serial = process.env.TWITCHEXT_ADB_SERIAL || devices[0];

console.log(`📱 capturing ${serial} at ${FPS}fps`);
console.log(`🔎 ${matcher.itemCount} items / ${matcher.refCount} reference fingerprints`);
console.log(`📡 posting to ${EBS_URL} for channel ${CHANNEL_ID}`);

let running = true;
let frames = 0;
let failures = 0;

process.on('SIGINT', () => {
  running = false;
  console.log('\n👋 stopping companion');
});

const intervalMs = Math.max(50, Math.round(1000 / FPS));

while (running) {
  const startedAt = Date.now();

  try {
    const frame = await captureFrame({ serial });
    // Timestamp *after* the grab: the frame reflects the device at this moment,
    // and the frontend's delay compensation is only as good as this number.
    const capturedAt = Date.now();

    const items = [];
    for (const slot of layout.slots) {
      const rect = slotToCapturePixels(slot, layout.gameArea, frame);
      const result = matcher.match(fingerprintRegion(frame, rect));
      const id = smoother.push(slot.id, result?.id ?? null);
      if (!id) continue;

      items.push({ id, x: slot.x, y: slot.y, w: slot.w, h: slot.h, score: result?.score ?? null });
    }

    await uploader.send({ capturedAt, items, frame: layout.frame });

    frames++;
    failures = 0;
    if (frames % (FPS * 30) === 0) {
      console.log(`… ${frames} frames, ${items.length} items visible, ${uploader.droppedCount} uploads dropped`);
    }
  } catch (err) {
    failures++;
    console.error(`⚠️  capture failed (${failures}): ${err?.message || err}`);
    // Back off after sustained failure — usually the emulator was closed.
    if (failures >= 5) await sleep(2000);
  }

  await sleep(Math.max(0, intervalMs - (Date.now() - startedAt)));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

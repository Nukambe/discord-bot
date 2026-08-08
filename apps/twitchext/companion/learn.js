import 'dotenv/config';
import { captureFrame, listDevices } from './capture/adb.js';
import {
  averageFingerprints,
  decodeFingerprint,
  encodeFingerprint,
  fingerprintRegion,
  similarity,
} from './vision/fingerprint.js';
import { loadItems, loadLayout, saveItems, slotToCapturePixels } from './layout.js';

/**
 * Teaches the companion what an item looks like, by capturing it where it
 * actually renders rather than from a wiki sprite sheet. That matters: the
 * emulator scales, compresses and colour-shifts icons, and a reference taken
 * through the same pipeline as the live capture matches far more reliably.
 *
 *   node apps/twitchext/companion/learn.js frog --slot item1
 *   node apps/twitchext/companion/learn.js frog --slot item1 --samples 12 --replace
 */

const args = parseArgs(process.argv.slice(2));
const itemId = args._[0];

if (!itemId) {
  console.error('Usage: learn.js <item-id> --slot <slot-id> [--samples N] [--replace]');
  process.exit(1);
}

const layout = await loadLayout();
const itemDb = await loadItems();

const item = itemDb.items[itemId];
if (!item) {
  console.error(`No item "${itemId}" in items.json. Known ids: ${Object.keys(itemDb.items).join(', ')}`);
  process.exit(1);
}

const slotId = args.slot || layout.slots[0].id;
const slot = layout.slots.find(s => s.id === slotId);
if (!slot) {
  console.error(`No slot "${slotId}" in layout.json. Known slots: ${layout.slots.map(s => s.id).join(', ')}`);
  process.exit(1);
}

const samples = Number(args.samples) || 8;
const devices = await listDevices();
if (!devices.length) throw new Error('No adb devices. Is the emulator running?');
const serial = process.env.TWITCHEXT_ADB_SERIAL || devices[0];

console.log(`📚 learning "${itemId}" from slot ${slotId} — make sure it is on screen now.`);

const vectors = [];
for (let i = 0; i < samples; i++) {
  const frame = await captureFrame({ serial });
  const rect = slotToCapturePixels(slot, layout.gameArea, frame);
  vectors.push(fingerprintRegion(frame, rect));
  process.stdout.write(`\r   sample ${i + 1}/${samples}`);
  await sleep(120);
}
console.log();

// Spread across samples tells us whether we captured a stable icon or caught an
// animation mid-frame. Low agreement here means the resulting reference is junk.
const mean = averageFingerprints(vectors.map(v => Float32Array.from(v)));
const agreement = vectors.reduce((min, v) => Math.min(min, similarity(v, mean)), 1);
console.log(`   frame agreement: ${agreement.toFixed(3)}`);

if (agreement < 0.9) {
  console.warn(
    '⚠️  Samples disagree — the slot is probably animating, mis-aligned, or empty.\n' +
      '    Check data/calibration.png before trusting this fingerprint.'
  );
}

// Warn on collisions now rather than letting the matcher silently refuse to
// choose between two items later.
for (const [otherId, other] of Object.entries(itemDb.items)) {
  if (otherId === itemId) continue;
  for (const fp of other.fingerprints || []) {
    const score = similarity(mean, decodeFingerprint(fp));
    if (score > 0.9) {
      console.warn(`⚠️  looks ${score.toFixed(3)} similar to "${otherId}" — matcher may refuse both.`);
    }
  }
}

if (args.replace) item.fingerprints = [];
item.fingerprints.push(encodeFingerprint(mean));

itemDb.version = (itemDb.version || 0) + 1;
itemDb.updatedAt = new Date().toISOString();
await saveItems(itemDb);

console.log(`✅ "${itemId}" now has ${item.fingerprints.length} reference fingerprint(s); db version ${itemDb.version}`);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else out[key] = argv[++i];
    } else {
      out._.push(argv[i]);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

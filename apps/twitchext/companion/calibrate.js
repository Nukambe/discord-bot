import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { captureFrame, listDevices } from './capture/adb.js';
import { encodePng, strokeRect } from './capture/png.js';
import { loadLayout, slotToCapturePixels, LAYOUT_PATH } from './layout.js';

/**
 * Writes a capture with the configured slot rects drawn over it, so the streamer
 * can see what the matcher is actually looking at and nudge layout.json until
 * the boxes sit on the item icons.
 *
 *   node apps/twitchext/companion/calibrate.js
 *   node apps/twitchext/companion/calibrate.js --raw   (no boxes, for measuring)
 */

const raw = process.argv.includes('--raw');
const outPath = fileURLToPath(new URL('../data/calibration.png', import.meta.url));

const devices = await listDevices();
if (!devices.length) throw new Error('No adb devices. Is the emulator running?');
const serial = process.env.TWITCHEXT_ADB_SERIAL || devices[0];

const frame = await captureFrame({ serial });
console.log(`📐 capture is ${frame.width}x${frame.height}`);

if (!raw) {
  const layout = await loadLayout();
  for (const slot of layout.slots) {
    const rect = slotToCapturePixels(slot, layout.gameArea, frame);
    strokeRect(frame, rect);
    console.log(
      `   ${slot.id.padEnd(10)} game(${fmt(slot.x)}, ${fmt(slot.y)}, ${fmt(slot.w)}, ${fmt(slot.h)})` +
        `  ->  px(${Math.round(rect.x)}, ${Math.round(rect.y)}, ${Math.round(rect.w)}, ${Math.round(rect.h)})`
    );
  }
  console.log(`\nEdit slot rects in ${LAYOUT_PATH}`);
  console.log('Slot coords are 0..1 within gameArea, so they survive a resolution change.');
  console.log('To convert a pixel measurement: x_norm = x_px / capture_width.');
}

await writeFile(outPath, encodePng(frame));
console.log(`\n🖼️  wrote ${outPath}`);

function fmt(n) {
  return n.toFixed(3);
}

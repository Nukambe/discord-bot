import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isRect } from '../shared/protocol.js';

const LAYOUT_PATH = fileURLToPath(new URL('../data/layout.json', import.meta.url));
const ITEMS_PATH = fileURLToPath(new URL('../data/items.json', import.meta.url));

/**
 * The layout describes where things are, in two different spaces:
 *
 *   gameArea — the sub-rect of the *capture* that is actually the game, normalized
 *              0..1 within the capture. Usually the whole thing, but emulators
 *              sometimes letterbox or draw a toolbar down one side.
 *   slots    — item slots, normalized 0..1 within gameArea.
 *   frame    — where the game appears in the *OBS scene*, normalized 0..1 within
 *              the stream canvas. Purely a passthrough for the frontend; the
 *              companion never uses it for cropping.
 */
export async function loadLayout() {
  const layout = JSON.parse(await readFile(LAYOUT_PATH, 'utf8'));

  if (!isRect(layout.gameArea)) throw new Error('layout.gameArea is not a valid rect');
  if (!isRect(layout.frame)) throw new Error('layout.frame is not a valid rect');
  if (!Array.isArray(layout.slots) || !layout.slots.length) {
    throw new Error('layout.slots is empty — run `npm run twitchext:calibrate` first');
  }

  for (const slot of layout.slots) {
    if (!slot.id) throw new Error('every slot needs an "id"');
    if (!isRect(slot)) throw new Error(`slot "${slot.id}" is not a valid rect`);
  }

  return layout;
}

export async function saveLayout(layout) {
  await writeFile(LAYOUT_PATH, `${JSON.stringify(layout, null, 2)}\n`);
}

export async function loadItems() {
  return JSON.parse(await readFile(ITEMS_PATH, 'utf8'));
}

export async function saveItems(db) {
  await writeFile(ITEMS_PATH, `${JSON.stringify(db, null, 2)}\n`);
}

/**
 * game-space slot rect -> capture pixels, for cropping a frame.
 * `capture` is the screencap ({ width, height }), not layout.frame — those are
 * different rects and mixing them up puts every crop in the wrong place.
 */
export function slotToCapturePixels(slot, gameArea, capture) {
  const gx = gameArea.x * capture.width;
  const gy = gameArea.y * capture.height;
  const gw = gameArea.w * capture.width;
  const gh = gameArea.h * capture.height;

  return {
    x: gx + slot.x * gw,
    y: gy + slot.y * gh,
    w: slot.w * gw,
    h: slot.h * gh,
  };
}

export { LAYOUT_PATH, ITEMS_PATH };

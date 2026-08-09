/**
 * Wire contract shared by the companion app, the EBS, and the extension frontend.
 *
 * Coordinate spaces (there are three, and mixing them up is the main source of
 * misaligned tooltips):
 *
 *  1. capture px  — raw pixels of the `adb screencap` buffer.
 *  2. game space  — normalized 0..1 within the emulator's game area. Slot layout
 *                   lives here, so it survives the streamer changing resolution.
 *  3. stream space— normalized 0..1 within the Twitch video canvas. The frontend
 *                   maps game -> stream using `frame`, the rect describing where
 *                   the emulator sits in the OBS scene (this is what accounts for
 *                   letterboxing / webcam borders / side panels).
 */

export const PROTOCOL_VERSION = 1;

/** Snapshots older than this are dropped from the EBS ring buffer. */
export const SNAPSHOT_TTL_MS = 60_000;

/** Upper bound on viewer-side delay compensation. Twitch delay is rarely above this. */
export const MAX_DELAY_MS = 30_000;

/** Default assumed broadcast delay when the streamer hasn't measured theirs. */
export const DEFAULT_DELAY_MS = 8_000;

/** A rect, always normalized 0..1 within its coordinate space. */
export function isRect(r) {
  return (
    r &&
    ['x', 'y', 'w', 'h'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k])) &&
    r.w > 0 &&
    r.h > 0
  );
}

/**
 * Validates a snapshot posted by the companion app. Returns a cleaned copy, or
 * throws. Kept strict because this is the one endpoint an outsider could try to
 * feed garbage to if the companion secret ever leaked.
 */
export function parseSnapshot(body) {
  if (!body || typeof body !== 'object') throw new Error('snapshot must be an object');

  const capturedAt = Number(body.capturedAt);
  if (!Number.isFinite(capturedAt)) throw new Error('capturedAt must be an epoch-ms number');

  if (!Array.isArray(body.items)) throw new Error('items must be an array');
  if (body.items.length > 128) throw new Error('too many items in one snapshot');

  const items = body.items.map((raw, i) => {
    if (!raw || typeof raw.id !== 'string' || !raw.id) throw new Error(`items[${i}].id missing`);
    if (!isRect(raw)) throw new Error(`items[${i}] is not a valid rect`);
    return {
      id: raw.id.slice(0, 64),
      x: clamp01(raw.x),
      y: clamp01(raw.y),
      w: clamp01(raw.w),
      h: clamp01(raw.h),
      // Confidence rides along so the frontend can dim low-certainty matches.
      score: Number.isFinite(raw.score) ? Math.round(raw.score * 1000) / 1000 : null,
    };
  });

  const frame = isRect(body.frame)
    ? { x: clamp01(body.frame.x), y: clamp01(body.frame.y), w: clamp01(body.frame.w), h: clamp01(body.frame.h) }
    : null;

  return { capturedAt, items, frame };
}

export function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

/** game space -> stream space, given where the emulator sits in the OBS scene. */
export function gameToStream(rect, frame) {
  return {
    x: frame.x + rect.x * frame.w,
    y: frame.y + rect.y * frame.h,
    w: rect.w * frame.w,
    h: rect.h * frame.h,
  };
}

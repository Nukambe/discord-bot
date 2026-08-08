/**
 * Item recognition primitives.
 *
 * The research suggested OpenCV template matching over the whole frame. We don't
 * need that here: the game draws items into fixed UI slots, so we already know
 * *where* to look and only need to answer *which item is this*. That reduces the
 * problem to comparing a small crop against a set of reference crops, which is a
 * normalized cross-correlation over a downsampled thumbnail — a few dozen lines,
 * no native dependency, and roughly 0.1ms per slot.
 *
 * If this ever proves too weak (heavy animation, overlapping VFX), swap in an
 * OpenCV-backed implementation behind the same two functions.
 */

/** Thumbnails are FP_GRID x FP_GRID RGB. 16 keeps icon shape and rarity color. */
export const FP_GRID = 16;
export const FP_LEN = FP_GRID * FP_GRID * 3;

/**
 * Box-downsamples `rect` (in capture pixels) out of an RGBA frame, then
 * mean-centers and L2-normalizes it. Mean-centering is what makes the match
 * robust to the emulator's brightness drifting between scenes.
 */
export function fingerprintRegion(frame, rect) {
  const { width, height, data } = frame;

  // Clamp to the frame so a slightly-off calibration degrades instead of crashing.
  const rx = Math.max(0, Math.min(width - 1, Math.floor(rect.x)));
  const ry = Math.max(0, Math.min(height - 1, Math.floor(rect.y)));
  const rw = Math.max(1, Math.min(width - rx, Math.floor(rect.w)));
  const rh = Math.max(1, Math.min(height - ry, Math.floor(rect.h)));

  const out = new Float32Array(FP_LEN);
  const cellW = rw / FP_GRID;
  const cellH = rh / FP_GRID;

  for (let gy = 0; gy < FP_GRID; gy++) {
    const y0 = ry + Math.floor(gy * cellH);
    const y1 = Math.max(y0 + 1, ry + Math.floor((gy + 1) * cellH));

    for (let gx = 0; gx < FP_GRID; gx++) {
      const x0 = rx + Math.floor(gx * cellW);
      const x1 = Math.max(x0 + 1, rx + Math.floor((gx + 1) * cellW));

      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;

      for (let y = y0; y < y1 && y < ry + rh; y++) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1 && x < rx + rw; x++, i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }

      const o = (gy * FP_GRID + gx) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }

  return normalize(out);
}

/** Mean-center then scale to unit length, so similarity() is a plain dot product. */
export function normalize(vec) {
  let mean = 0;
  for (let i = 0; i < vec.length; i++) mean += vec[i];
  mean /= vec.length;

  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    vec[i] -= mean;
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);

  // A perfectly flat crop (empty black slot) has no variance to normalize.
  if (norm < 1e-6) return vec.fill(0);

  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Normalized cross-correlation of two fingerprints, in [-1, 1]. */
export function similarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Fingerprints are stored in items.json as base64 int8, ~410 chars each. */
export function encodeFingerprint(vec) {
  const bytes = Buffer.allocUnsafe(vec.length);
  for (let i = 0; i < vec.length; i++) {
    bytes[i] = Math.max(-127, Math.min(127, Math.round(vec[i] * 127))) & 0xff;
  }
  return bytes.toString('base64');
}

export function decodeFingerprint(b64) {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length !== FP_LEN) {
    throw new Error(`fingerprint has ${bytes.length} bytes, expected ${FP_LEN}`);
  }
  const vec = new Float32Array(FP_LEN);
  for (let i = 0; i < FP_LEN; i++) {
    const signed = bytes[i] > 127 ? bytes[i] - 256 : bytes[i];
    vec[i] = signed / 127;
  }
  // Re-normalize: quantization nudges the vector off the unit sphere.
  return normalize(vec);
}

/** Averages several captures of the same item so one bad frame can't define it. */
export function averageFingerprints(vectors) {
  if (!vectors.length) throw new Error('need at least one fingerprint to average');
  const acc = new Float32Array(FP_LEN);
  for (const v of vectors) {
    for (let i = 0; i < FP_LEN; i++) acc[i] += v[i];
  }
  return normalize(acc);
}

import { decodeFingerprint, similarity } from './fingerprint.js';

/**
 * Turns a slot fingerprint into an item id.
 *
 * Two guards keep bad matches off the stream:
 *  - `minScore`  — the best candidate must actually look like the item.
 *  - `minMargin` — it must beat the runner-up by a margin. Item sets usually
 *                  contain near-identical icons (same art, different tier), and
 *                  a confident-but-wrong tooltip is worse than none.
 */
export function createMatcher(itemDb, { minScore = 0.86, minMargin = 0.03 } = {}) {
  const refs = [];

  for (const [id, item] of Object.entries(itemDb.items || {})) {
    for (const fp of item.fingerprints || []) {
      refs.push({ id, vec: decodeFingerprint(fp) });
    }
  }

  if (!refs.length) {
    throw new Error(
      'Item database has no fingerprints. Run `npm run twitchext:learn -- <item-id>` ' +
        'while the item is on screen to teach the companion what it looks like.'
    );
  }

  return {
    refCount: refs.length,
    itemCount: new Set(refs.map(r => r.id)).size,

    /** Returns { id, score, margin } or null when nothing is confident enough. */
    match(vec) {
      let best = { id: null, score: -Infinity };
      let secondBestOtherId = -Infinity;

      for (const ref of refs) {
        const score = similarity(vec, ref.vec);
        if (score > best.score) {
          // The old winner becomes runner-up only if it's a *different* item;
          // multiple fingerprints of the same item shouldn't suppress each other.
          if (best.id !== null && best.id !== ref.id && best.score > secondBestOtherId) {
            secondBestOtherId = best.score;
          }
          best = { id: ref.id, score };
        } else if (ref.id !== best.id && score > secondBestOtherId) {
          secondBestOtherId = score;
        }
      }

      const margin = secondBestOtherId === -Infinity ? 1 : best.score - secondBestOtherId;
      if (best.score < minScore || margin < minMargin) return null;

      return { id: best.id, score: best.score, margin };
    },
  };
}

/**
 * Debounces per-slot results across frames.
 *
 * Raw frame-by-frame matching flickers: an item animates, one frame drops below
 * threshold, the tooltip vanishes and reappears. We only publish a slot's value
 * after it has agreed with itself `stability` frames in a row.
 */
export function createSlotSmoother({ stability = 3 } = {}) {
  const state = new Map(); // slotId -> { published, candidate, streak }

  return {
    /** @param {string|null} id — matched item id for this frame, or null for empty. */
    push(slotId, id) {
      let s = state.get(slotId);
      if (!s) {
        s = { published: null, candidate: id, streak: 1 };
        state.set(slotId, s);
      } else if (s.candidate === id) {
        s.streak++;
      } else {
        s.candidate = id;
        s.streak = 1;
      }

      if (s.streak >= stability) s.published = s.candidate;
      return s.published;
    },

    reset() {
      state.clear();
    },
  };
}

import { resolveEbsUrl } from './env.js';

/**
 * Keeps a local buffer of timestamped game-state snapshots.
 *
 * The core problem this solves: the viewer's video is 5-20s behind the
 * streamer's emulator. If we rendered the newest snapshot, hover regions would
 * sit where items are going to be, not where the viewer can see them. So we
 * keep history and let the render loop ask "what was on screen at time T".
 */
export function createStateBuffer({ getToken, onError }) {
  const base = resolveEbsUrl();

  let snapshots = [];
  let frame = null;
  let clockOffset = 0; // serverNow - clientNow
  let lastSeen = 0;
  let polling = false;

  return {
    get frame() {
      return frame;
    },

    get size() {
      return snapshots.length;
    },

    /** Server-aligned wall clock, immune to the viewer's machine being wrong. */
    now() {
      return Date.now() + clockOffset;
    },

    /**
     * The snapshot that was current `delayMs` ago — i.e. what the viewer is
     * actually looking at right now.
     */
    at(delayMs) {
      const target = this.now() - delayMs;
      let chosen = null;
      for (const snap of snapshots) {
        if (snap.t <= target) chosen = snap;
        else break;
      }
      return chosen;
    },

    /** Accepts a PubSub nudge, which may arrive before the next poll lands. */
    ingest({ t, items, frame: incomingFrame }) {
      if (incomingFrame) frame = incomingFrame;
      if (!t || snapshots.some(s => s.t === t)) return;
      insert({ t, items: items || [] });
      if (t > lastSeen) lastSeen = t;
    },

    async poll() {
      if (polling) return;
      polling = true;

      try {
        const token = getToken();
        if (!token) return;

        const res = await fetch(`${base}/api/state?since=${lastSeen}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`state ${res.status}`);

        const body = await res.json();
        clockOffset = body.serverTime - Date.now();
        if (body.frame) frame = body.frame;

        for (const snap of body.snapshots || []) {
          insert(snap);
          if (snap.t > lastSeen) lastSeen = snap.t;
        }
        prune();
      } catch (err) {
        onError?.(err);
      } finally {
        polling = false;
      }
    },

    async fetchItems() {
      const res = await fetch(`${base}/api/items`);
      if (!res.ok) throw new Error(`items ${res.status}`);
      return (await res.json()).items || {};
    },
  };

  // Snapshots usually arrive in order, so scan from the end.
  function insert(snap) {
    let i = snapshots.length;
    while (i > 0 && snapshots[i - 1].t > snap.t) i--;
    snapshots.splice(i, 0, snap);
  }

  function prune() {
    // Keep a little more than the maximum delay a viewer can dial in.
    const cutoff = Date.now() + clockOffset - 45_000;
    let drop = 0;
    while (drop < snapshots.length && snapshots[drop].t < cutoff) drop++;
    if (drop) snapshots.splice(0, drop);
  }
}

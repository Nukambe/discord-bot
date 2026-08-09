import { SNAPSHOT_TTL_MS } from '../shared/protocol.js';

/**
 * In-memory game state, keyed by channel id.
 *
 * We keep a short *history* rather than just the latest snapshot, and that is
 * the whole trick behind delay compensation: the viewer is watching video from
 * N seconds ago, so the frontend asks for the snapshot that was current N
 * seconds ago. A single "latest state" value cannot answer that question.
 *
 * Memory is bounded by TTL and by a hard cap per channel. Nothing is persisted —
 * game state is worthless once the stream ends, and a restart just means the
 * companion repopulates within a frame.
 */
const MAX_SNAPSHOTS_PER_CHANNEL = 240; // 60s at 4fps

export function createStore() {
  const channels = new Map(); // channelId -> { snapshots: [], frame, updatedAt }

  return {
    put(channelId, snapshot) {
      let channel = channels.get(channelId);
      if (!channel) {
        channel = { snapshots: [], frame: null, updatedAt: 0 };
        channels.set(channelId, channel);
      }

      if (snapshot.frame) channel.frame = snapshot.frame;
      channel.updatedAt = Date.now();
      channel.snapshots.push({ t: snapshot.capturedAt, items: snapshot.items });

      // The companion can post out of order after a network stall; keeping the
      // buffer sorted lets the reader do a straight scan.
      if (channel.snapshots.length > 1 && snapshot.capturedAt < channel.snapshots.at(-2).t) {
        channel.snapshots.sort((a, b) => a.t - b.t);
      }

      prune(channel);
      return channel;
    },

    /**
     * Returns snapshots newer than `since`, plus the frame rect. The frontend
     * buffers these locally and picks the right one for its delay setting —
     * pushing that choice to the client keeps the EBS stateless about viewers.
     */
    get(channelId, since = 0) {
      const channel = channels.get(channelId);
      if (!channel) return { frame: null, snapshots: [], updatedAt: 0 };

      prune(channel);
      return {
        frame: channel.frame,
        updatedAt: channel.updatedAt,
        snapshots: channel.snapshots.filter(s => s.t > since),
      };
    },

    /** Drops channels that went quiet, so a long-lived EBS doesn't creep. */
    sweep() {
      const cutoff = Date.now() - SNAPSHOT_TTL_MS * 5;
      for (const [id, channel] of channels) {
        if (channel.updatedAt < cutoff) channels.delete(id);
      }
    },

    get channelCount() {
      return channels.size;
    },
  };
}

function prune(channel) {
  const cutoff = Date.now() - SNAPSHOT_TTL_MS;
  let firstLive = 0;
  while (firstLive < channel.snapshots.length && channel.snapshots[firstLive].t < cutoff) firstLive++;
  if (firstLive) channel.snapshots.splice(0, firstLive);

  const overflow = channel.snapshots.length - MAX_SNAPSHOTS_PER_CHANNEL;
  if (overflow > 0) channel.snapshots.splice(0, overflow);
}

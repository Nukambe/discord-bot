import { request } from 'undici';
import { signBroadcastToken } from './auth.js';

/**
 * Twitch extension PubSub broadcast.
 *
 * The research described PubSub as the main transport, but it can't be: Twitch
 * caps broadcasts at 100 messages per minute per channel, and the message body
 * at 5KB. At 4fps we'd exceed the rate limit by ~2.5x within the first minute
 * and start getting 429s.
 *
 * So PubSub is used as a *nudge* here, throttled to roughly 1/s: it tells the
 * frontend "there is new state, and here is a small preview", which lets a
 * viewer who just loaded the page see tooltips immediately. The authoritative
 * history still comes from polling /api/state. If PubSub is unconfigured the
 * extension degrades to poll-only, which works fine.
 */
const MIN_INTERVAL_MS = 1000;
const MAX_MESSAGE_BYTES = 5 * 1024;

export function createPubSub({ clientId, secret, ownerId, enabled = true }) {
  if (!enabled || !clientId || !ownerId) {
    return { enabled: false, async publish() { return false; } };
  }

  const lastSentAt = new Map(); // channelId -> ms
  let lastErrorAt = 0;

  return {
    enabled: true,

    async publish(channelId, snapshot) {
      const now = Date.now();
      if (now - (lastSentAt.get(channelId) || 0) < MIN_INTERVAL_MS) return false;
      lastSentAt.set(channelId, now);

      // Only the fields the frontend needs to render — score and anything else
      // stays out so we keep clear of the 5KB ceiling.
      const message = JSON.stringify({
        t: snapshot.capturedAt,
        frame: snapshot.frame,
        items: snapshot.items.map(i => ({ id: i.id, x: i.x, y: i.y, w: i.w, h: i.h })),
      });

      if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
        warnThrottled(`snapshot too large for PubSub (${Buffer.byteLength(message)}B); relying on polling`);
        return false;
      }

      try {
        const token = signBroadcastToken({ secret, ownerId, channelId });
        const res = await request('https://api.twitch.tv/helix/extensions/pubsub', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'client-id': clientId,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            target: ['broadcast'],
            broadcaster_id: String(channelId),
            is_global_broadcast: false,
            message,
          }),
          headersTimeout: 4000,
          bodyTimeout: 4000,
        });

        const text = await res.body.text();
        if (res.statusCode >= 300) {
          warnThrottled(`PubSub ${res.statusCode}: ${text.slice(0, 200)}`);
          return false;
        }
        return true;
      } catch (err) {
        warnThrottled(err?.message || String(err));
        return false;
      }
    },
  };

  function warnThrottled(message) {
    const now = Date.now();
    if (now - lastErrorAt < 15_000) return;
    lastErrorAt = now;
    console.error(`⚠️  pubsub: ${message}`);
  }
}

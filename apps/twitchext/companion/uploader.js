import { request } from 'undici';

/**
 * Ships snapshots to the EBS.
 *
 * Deliberately fire-and-forget with a single in-flight request: if the network
 * hiccups we want to drop stale frames, not queue them. A snapshot that arrives
 * two seconds late is worse than useless — the viewer would get tooltips for
 * items that are no longer on screen.
 */
export function createUploader({ ebsUrl, secret, channelId }) {
  const endpoint = new URL('/api/snapshot', ebsUrl).toString();

  let inFlight = false;
  let dropped = 0;
  let lastErrorAt = 0;

  return {
    get droppedCount() {
      return dropped;
    },

    async send(snapshot) {
      if (inFlight) {
        dropped++;
        return false;
      }
      inFlight = true;

      try {
        const res = await request(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify({ channelId, ...snapshot }),
          headersTimeout: 4000,
          bodyTimeout: 4000,
        });

        // Drain regardless of status so the socket can be reused.
        const text = await res.body.text();

        if (res.statusCode >= 300) {
          warnThrottled(`EBS rejected snapshot (${res.statusCode}): ${text.slice(0, 200)}`);
          return false;
        }
        return true;
      } catch (err) {
        warnThrottled(err?.message || String(err));
        return false;
      } finally {
        inFlight = false;
      }
    },
  };

  // The capture loop runs several times a second; without this an EBS outage
  // would print thousands of identical lines.
  function warnThrottled(message) {
    const now = Date.now();
    if (now - lastErrorAt < 5000) return;
    lastErrorAt = now;
    console.error(`⚠️  upload failed: ${message}`);
  }
}

/**
 * "Has this already gone out?" checks backed by Discord message history.
 *
 * familygo has no database (see db.js — even config lives in a channel), so the channel
 * itself is the persistence layer: before posting a wiki link we look for that link in the
 * channel's recent messages. That's what lets the free-dice and future-events jobs run on a
 * repeating cron and scan a multi-day window without ever double-posting — a restart, a
 * retried fetch or an extra tick all converge on the same answer.
 */

/** Discord's per-fetch cap; ~100 messages covers well over the 2-day window we scan. */
const DEFAULT_HISTORY_LIMIT = 100;

/**
 * Reduce a URL to a `host/path` key so trivially different spellings of the same link
 * (trailing slash, http vs https, tracking query) still compare equal.
 * @param {string} url
 * @returns {string} e.g. "monopolygo.wiki/roll-treasures-starts-august-18-2026-rewards-guide"
 */
export function urlKey(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

/**
 * Concatenate the recent message content and embed URLs of the given channels into one
 * lowercase blob, cheap to test with `haystack.includes(urlKey(link))`.
 *
 * A channel that can't be read contributes nothing rather than throwing — the caller then
 * risks a duplicate post, which is the better failure than silently skipping a real one.
 *
 * @param {import('discord.js').Client} client - A logged-in Discord client.
 * @param {Array<string|null|undefined>} channelIds - Channels to scan; duplicates/blanks ignored.
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<string>} Lowercased haystack of everything recently posted.
 */
export async function fetchPostedHaystack(client, channelIds, opts = {}) {
  const { limit = DEFAULT_HISTORY_LIMIT } = opts;
  const parts = [];

  for (const channelId of new Set((channelIds || []).filter(Boolean))) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.messages) {
        console.warn(`[alreadyPosted] Channel ${channelId} unavailable — skipping dedupe for it`);
        continue;
      }
      const messages = await channel.messages.fetch({ limit }).catch(() => null);
      if (!messages) continue;

      for (const msg of messages.values()) {
        if (msg.content) parts.push(msg.content);
        for (const embed of msg.embeds || []) {
          if (embed?.url) parts.push(embed.url);
        }
      }
    } catch (err) {
      console.warn(`[alreadyPosted] Failed reading channel ${channelId}:`, err?.message);
    }
  }

  return parts.join("\n").toLowerCase();
}

/**
 * @param {string} haystack - From fetchPostedHaystack.
 * @param {string} url
 * @returns {boolean} Whether `url` already appears in the scanned history.
 */
export function haystackHasUrl(haystack, url) {
  const key = urlKey(url);
  return Boolean(key) && haystack.includes(key);
}

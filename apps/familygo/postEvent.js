// postEvent.js

/**
 * Post a Monopoly GO daily event update to a Discord channel.
 *
 * Channel selection:
 *  - When debug === true, posts to process.env.TEST_CHANNEL_ID (required).
 *  - When debug === false, posts to process.env.CHANNEL_ID (required).
 *
 * Discord limits handled:
 *  - Content is split into 2000-char chunks.
 *  - Embeds capped at 10 (Discord max). Extras are dropped with a warning.
 *
 * @param {object} args
 * @param {import('discord.js').Client} args.client - A logged-in Discord client.
 * @param {string} args.content - Message content (can include emojis).
 * @param {Array<object>} [args.embeds=[]] - Optional embeds to attach.
 * @param {boolean} [args.debug=false] - If true, route to TEST_CHANNEL_ID.
 * @returns {Promise<Array<import('discord.js').Message>>} The sent messages.
 */
export async function postEvent({ client, content, embeds = [], debug = false }) {
  if (!client) throw new Error('[postEvent] Missing Discord client');
  if (!content && (!embeds || embeds.length === 0)) {
    throw new Error('[postEvent] Provide content or embeds');
  }

  const channelId = debug ? process.env.TEST_CHANNEL_ID : process.env.CHANNEL_ID;
  if (!channelId) {
    const which = debug ? 'TEST_CHANNEL_ID' : 'CHANNEL_ID';
    throw new Error(`[postEvent] Missing process.env.${which}`);
  }

  // Fetch channel
  const channel = await client.channels.fetch(channelId).catch((e) => {
    throw new Error(`[postEvent] Failed to fetch channel ${channelId}: ${e?.message || e}`);
  });

  // Ensure we don't exceed Discord's 10-embed limit
  let usedEmbeds = Array.isArray(embeds) ? embeds.slice(0, 10) : [];
  if (embeds.length > 10) {
    console.warn(
      `[postEvent] Provided ${embeds.length} embeds; Discord allows 10. Dropping ${embeds.length - 10}.`
    );
  }

  // Split content into 2000-char chunks (Discord hard limit)
  const chunks = splitContent(content, 2000);
  const sent = [];

  // First message can include embeds; subsequent messages are content-only
  if (chunks.length > 0) {
    const first = await channel.send({ content: chunks[0], embeds: usedEmbeds }).catch((e) => {
      throw new Error(`[postEvent] Failed to send first message: ${e?.message || e}`);
    });
    sent.push(first);

    for (let i = 1; i < chunks.length; i++) {
      const msg = await channel.send({ content: chunks[i] }).catch((e) => {
        throw new Error(`[postEvent] Failed to send message chunk ${i + 1}: ${e?.message || e}`);
      });
      sent.push(msg);
    }
  } else {
    // No content, only embeds (valid)
    const msg = await channel.send({ embeds: usedEmbeds }).catch((e) => {
      throw new Error(`[postEvent] Failed to send embeds-only message: ${e?.message || e}`);
    });
    sent.push(msg);
  }

  const where = debug ? 'TEST_CHANNEL_ID' : 'CHANNEL_ID';
  console.log(`[postEvent] Sent ${sent.length} message(s) to ${where}=${channelId}`);

  forwardImages({ client, content, embeds, debug });
  return sent;
}

async function forwardImages({ client, content, embeds = [], debug = false }) {
  const [mainEmbed, ...imageEmbeds] = embeds;
  const forwardEmbed = {
    title: mainEmbed.title.replace("Events", "Milestones"),
    image: mainEmbed.image,
  };

  const channelId = debug ? process.env.TEST_CHANNEL_ID : process.env.IMG_CHANNEL_ID;

  // Fetch channel
  const channel = await client.channels.fetch(channelId).catch((e) => {
    throw new Error(`[postEvent] Failed to fetch channel ${channelId}: ${e?.message || e}`);
  });

  await channel.send({ content: content, embeds: [forwardEmbed, ...imageEmbeds] });
}

/**
 * Split a string into chunks that are <= n characters.
 * Empty/undefined input becomes an empty list.
 * @param {string} str
 * @param {number} n
 * @returns {string[]}
 */
function splitContent(str, n) {
  if (!str) return [];
  const out = [];
  for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n));
  return out;
}

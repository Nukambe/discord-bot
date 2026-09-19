import { AttachmentBuilder } from "discord.js";
import { COLLECTIBLE_CATEGORIES, COLLECTIBLES_SOURCE_URL, getCollectibles } from "./getCollectibles.js";
import { getDb, updateLastPosts } from "./db.js";

/** Live channel for collectible spoiler posts. Hardcoded (not env-based), like free dice. */
const SPOILERS_CHANNEL_ID = "1449448347965460553";

/** Discord's per-message attachment cap; extra images spill into follow-up messages. */
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * How many of each category's newest items the *first* ever run posts, before any seen-item
 * state exists. Everything not posted is still recorded as seen, so a first run never turns
 * into a 90-image dump of the existing back catalogue.
 *
 * Per request: shields announces its newest item so there's a real post to eyeball, dice
 * skins and tokens seed silently. Once a category has state this is never consulted again —
 * it only applies to a category whose key is missing from db.lastPosts.spoilers.
 */
const FIRST_RUN_POST_COUNT = { diceSkins: 0, shields: 1, tokens: 0 };

/** Items per category a debug run posts, ignoring seen-item state entirely. */
const DEBUG_POST_COUNT = 2;

/**
 * Post any collectibles that have appeared on the wiki's dice skins / shields / tokens
 * category pages since the last check, as one embed listing the new names plus the
 * artwork attached as images.
 *
 * "Since the last check" can't be a date comparison — the wiki exposes no date on an item
 * (see parseCollectibleItems), so this job remembers the item ids it has already seen in
 * `db.lastPosts.spoilers` and treats anything else on page 1 as new. The stored list is the
 * ids that were on page 1 at the end of the previous run, which is naturally bounded (~30
 * per category) and enough: the pages are newest-first, so an item only falls out of the
 * list once 30 newer items have pushed it off page 1, long after it stopped being a spoiler.
 * A watermark ("highest id seen") would be smaller but wrong — ids inside one release wave
 * are interleaved, so a genuinely new item can carry an id below one already recorded.
 *
 * Artwork goes out as real attachments rather than embed images for two reasons: Discord
 * clusters multiple attachments into a grid (an embed holds one image each, four at most),
 * and attachments keep the source PNGs' alpha channel, so the icons sit transparent on
 * whatever background the viewer's theme uses.
 *
 * An item the wiki has listed but Scopely hasn't uploaded artwork for yet gets its name with
 * an "(image unavailable)" note — the record always carries an image URL, but the CDN 404s
 * until the asset lands. Such an item is recorded as seen like any other and is never
 * re-announced when its artwork does arrive.
 *
 * Called from the nightly 7:30pm cron (the 'collectible-spoilers' job in index.js) and the
 * manual /spoilers command.
 *
 * @param {import('discord.js').Client} client - A logged-in Discord client.
 * @param {{ debug?: boolean }} [opts]
 *  - debug: post to process.env.TEST_CHANNEL_ID instead of the live channel, dump the fetched
 *    HTML, and ignore/leave untouched the seen-item state — the newest few items of every
 *    category are posted, so a manual run always produces a message to eyeball.
 */
export const postCollectibleSpoilers = async (client, opts = {}) => {
  const { debug = false } = opts;
  console.log(`👀 Checking for new collectibles${debug ? " (debug → test channel)" : ""}`);

  const byCategory = await getCollectibles({ debug });
  if (!byCategory.size) {
    console.error("❌ No collectible category pages could be read — nothing to do");
    return;
  }

  // Read the state directly rather than through getLastPosts(), which flattens an
  // unreadable db into {}. The other jobs can absorb that — they fall back to scanning the
  // destination channel — but this one has no second source of truth, and "{}" here is
  // indistinguishable from "never checked", which would re-run the first-run seed (and its
  // post) every night for as long as the db stayed unreachable. Better to skip a night.
  let seenByCategory = {};
  if (!debug) {
    let db;
    try {
      db = await getDb(client);
    } catch (err) {
      console.error("❌ Couldn't read the db — skipping this check rather than risk re-posting:", err.message);
      return;
    }
    // A null db means it hasn't been created yet, which genuinely is a first run.
    seenByCategory = db?.lastPosts?.spoilers ?? {};
  }

  // Sections are built in COLLECTIBLE_CATEGORIES order so the post's headings always read
  // Dice Skins → Shields → Tokens, whichever categories happen to have something new.
  const sections = [];
  const nextSeen = {};
  for (const { key, heading } of COLLECTIBLE_CATEGORIES) {
    const items = byCategory.get(key);
    if (!items) continue; // page failed — leave this category's stored state alone

    const seen = seenByCategory[key];
    const newItems = debug
      ? items.slice(0, DEBUG_POST_COUNT)
      : seen
        ? items.filter((item) => !seen.includes(item.itemId))
        : items.slice(0, FIRST_RUN_POST_COUNT[key] ?? 0);

    if (!seen && !debug) {
      console.log(
        `🌱 First run for ${heading} — seeding ${items.length} item(s), posting ${newItems.length}`
      );
    } else if (!debug) {
      console.log(`ℹ️ ${heading}: ${newItems.length} new item(s)`);
    }

    nextSeen[key] = items.map((item) => item.itemId);
    if (newItems.length) sections.push({ heading, items: newItems });
  }

  if (!sections.length) {
    console.log("ℹ️ No new collectibles to post");
    // Still recorded: this is what makes a first run seed silently, and it keeps the stored
    // ids tracking page 1 as older items drop off.
    if (!debug) await recordSeen(client, seenByCategory, nextSeen);
    return;
  }

  // One HEAD per new item decides available vs "(image unavailable)", then the available
  // ones are downloaded for attaching. Plain HTTPS against the asset CDN — no Chrome needed.
  for (const section of sections) {
    for (const item of section.items) {
      item.image = await downloadItemImage(item);
    }
  }

  const posted = await sendSpoilerPost({ client, sections, debug });
  if (!posted) return; // send failed — leave state untouched so the next run retries

  if (!debug) await recordSeen(client, seenByCategory, nextSeen);
  console.log("🏁 Finished collectible spoilers check\n");
};

/**
 * Merge this run's per-category id lists into db.lastPosts.spoilers. Categories absent from
 * `nextSeen` (their page failed) keep whatever was stored.
 * @param {import('discord.js').Client} client
 * @param {Record<string, number[]>} seenByCategory - state as read at the start of the run
 * @param {Record<string, number[]>} nextSeen - ids seen this run, per category
 */
async function recordSeen(client, seenByCategory, nextSeen) {
  await updateLastPosts(client, { spoilers: { ...seenByCategory, ...nextSeen } });
}

/**
 * Build and send the post: one embed holding the name lists, with the artwork attached.
 *
 * The embed mirrors the daily post's layout — `source:` line in the message content, one
 * `__**Heading**__` field per section, literal "•" bullets rather than markdown list syntax
 * (some mobile clients fold a markdown list item into the line above it), and a zero-width
 * space closing every field but the last, which is what puts a blank line between sections
 * on iOS as well as desktop.
 *
 * @param {object} args
 * @param {import('discord.js').Client} args.client
 * @param {Array<{ heading: string, items: Array<{ itemId: number, name: string, image: {name: string, data: Buffer}|null }> }>} args.sections
 * @param {boolean} args.debug
 * @returns {Promise<boolean>} Whether the post went out.
 */
async function sendSpoilerPost({ client, sections, debug }) {
  const channelId = debug ? process.env.TEST_CHANNEL_ID : SPOILERS_CHANNEL_ID;
  if (!channelId) {
    console.error("❌ Missing process.env.TEST_CHANNEL_ID for a debug spoilers post");
    return false;
  }

  const channel = await client.channels.fetch(channelId).catch((err) => {
    console.error(`❌ Failed to fetch spoilers channel ${channelId}:`, err?.message || err);
    return null;
  });
  if (!channel) return false;

  const fields = sections.map(({ heading, items }) => ({
    name: `__**${heading}**__`,
    value: trimTo(
      items.map((item) => `• ${item.name}${item.image ? "" : " _(image unavailable)_"}`).join("\n"),
      1024
    ),
    inline: false,
  }));
  for (const field of fields.slice(0, -1)) field.value = trimTo(field.value, 1022) + "\n​";

  const embed = {
    title: "👀 Upcoming Collectibles?",
    url: COLLECTIBLES_SOURCE_URL,
    fields,
  };

  const files = sections
    .flatMap(({ items }) => items)
    .filter((item) => item.image)
    .map((item) => new AttachmentBuilder(item.image.data, { name: item.image.name }));

  const batches = chunk(files, MAX_ATTACHMENTS_PER_MESSAGE);
  try {
    await channel.send({
      content: `source: <${COLLECTIBLES_SOURCE_URL}>`,
      embeds: [embed],
      files: batches[0] ?? [],
    });
    // More images than one message can carry: the rest follow as attachment-only messages
    // so the whole batch still lands under the same heading list.
    for (const batch of batches.slice(1)) await channel.send({ files: batch });
  } catch (err) {
    console.error("💥 Failed to post collectible spoilers:", err?.message || err);
    return false;
  }

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  console.log(
    `✅ Posted ${total} collectible(s) (${files.length} image(s)) to ${debug ? "TEST_CHANNEL_ID" : "the spoilers channel"}=${channelId}`
  );
  return true;
}

/**
 * Download an item's artwork, or report it unavailable.
 *
 * A missing asset is a 404 from the CDN, not a missing URL: the wiki lists an item as soon
 * as it knows the name, with the image path it *will* have. The 404 body is an HTML error
 * page, so the response is checked rather than just saved.
 *
 * @param {{ itemId: number, name: string, imageUrl: string }} item
 * @returns {Promise<{ name: string, data: Buffer }|null>} null when the artwork isn't up yet.
 */
async function downloadItemImage(item) {
  if (!item.imageUrl) return null;
  try {
    const res = await fetch(item.imageUrl);
    if (!res.ok) {
      console.log(`🚫 No artwork yet for "${item.name}" (${res.status})`);
      return null;
    }
    const data = Buffer.from(await res.arrayBuffer());
    return { name: attachmentName(item), data };
  } catch (err) {
    console.warn(`⚠️ Couldn't download artwork for "${item.name}":`, err?.message || err);
    return null;
  }
}

/**
 * Attachment filename for an item, e.g. "82255-acme-tnt.png". The id keeps two items with
 * the same name (a shield and a token often share one) from colliding in a single message,
 * and Discord shows the name under the image.
 * @param {{ itemId: number, name: string, imageUrl: string }} item
 * @returns {string}
 */
function attachmentName({ itemId, name, imageUrl }) {
  const ext = (imageUrl.match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i)?.[1] || "png").toLowerCase();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
  return `${itemId}-${slug}.${ext}`;
}

/**
 * @param {Array} arr
 * @param {number} size
 * @returns {Array[]} `arr` split into runs of at most `size` (empty input → []).
 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {string} str
 * @param {number} max
 * @returns {string} `str` cut to `max` characters, ellipsised when it had to be cut.
 */
function trimTo(str, max) {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

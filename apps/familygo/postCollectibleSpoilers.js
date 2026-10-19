import { AttachmentBuilder } from "discord.js";
import { COLLECTIBLE_CATEGORIES, COLLECTIBLES_SOURCE_URL, getCollectibles } from "./getCollectibles.js";
import { getDb, updateLastPosts } from "./db.js";

/** Live channel for collectible spoiler posts. Hardcoded (not env-based), like free dice. */
const SPOILERS_CHANNEL_ID = "1449448347965460553";

/**
 * Images per message; extra images spill into follow-up messages. Discord allows 10, but its
 * 10-image grid crops the top of the last tile, so a grid stops at 9.
 */
const MAX_ATTACHMENTS_PER_MESSAGE = 9;

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
 * How many item ids each category remembers. Page 1 holds ~30, so this keeps about five
 * waves' worth — enough that an old item drifting back onto page 1 (the wiki's order wobbles
 * at the bottom of the page) is still recognized.
 */
const SEEN_CAP = 150;

/**
 * How long an item posted with "(image unavailable)" keeps being checked for its artwork.
 * Past this it's dropped quietly — Scopely uploads art within days, so an item still missing
 * it after two months has most likely been pulled.
 */
const AWAITING_ART_MAX_DAYS = 60;

/** Note an item's line carries when it's reposted because its artwork has landed. */
const ART_LANDED_NOTE = " _(image now available)_";

/**
 * Post any collectibles that have appeared on the wiki's dice skins / shields / tokens
 * category pages since the last check: one plain message per category listing the new names,
 * with that category's artwork attached underneath.
 *
 * "Since the last check" can't be a date comparison — the wiki exposes no date on an item
 * (see parseCollectibleItems), so this job remembers the item ids it has already seen in
 * `db.lastPosts.spoilers` and treats anything else on page 1 as new. The stored list is the
 * ids on page 1 this run followed by the ones remembered before, capped at SEEN_CAP. It used
 * to be page 1 alone, which forgot an item the moment newer ones pushed it to slot 31 — and
 * the bottom of page 1 isn't stable, so an old token (Speedy, 78196) drifted back on a few
 * days later and was announced as new.
 *
 * A watermark ("highest id seen") would be smaller but wrong — ids inside one release wave
 * are interleaved, so a genuinely new item can carry an id below one already recorded. A
 * *floor* is safe, though: anything below the oldest id remembered predates every wave this
 * job has seen, so it's old whether or not it's in the list (see isNewItem). The floor alone
 * wouldn't have caught Speedy, which sat in the same old wave as ids still remembered then;
 * the longer memory is the fix, the floor a backstop.
 *
 * Artwork goes out as real attachments rather than embed images for two reasons: Discord
 * clusters multiple attachments into a grid (an embed holds one image each, four at most),
 * and attachments keep the source PNGs' alpha channel, so the icons sit transparent on
 * whatever background the viewer's theme uses.
 *
 * An item the wiki has listed but Scopely hasn't uploaded artwork for yet gets its name with
 * an "(image unavailable)" note — the record always carries an image URL, but the CDN 404s
 * until the asset lands. Such an item is also remembered in `db.lastPosts.spoilersAwaitingArt`,
 * and every run re-checks those URLs (plain HTTPS, no browser); once one answers, the item is
 * posted again in its category with its artwork and an "(image now available)" note.
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
  let awaitingArt = [];
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

    // Absent (rather than empty) means the db predates the list: the items already posted
    // without artwork are only recorded in the channel, so they're read back from there once.
    const stored = db?.lastPosts?.spoilersAwaitingArt;
    awaitingArt = Array.isArray(stored) ? stored : await seedAwaitingArtFromChannel(client, byCategory);
  }

  const newByCategory = new Map();
  const nextSeen = {};
  for (const { key, heading } of COLLECTIBLE_CATEGORIES) {
    const items = byCategory.get(key);
    if (!items) continue; // page failed — leave this category's stored state alone

    const seen = seenByCategory[key];
    const newItems = debug
      ? items.slice(0, DEBUG_POST_COUNT)
      : seen
        ? items.filter((item) => isNewItem(item, seen))
        : items.slice(0, FIRST_RUN_POST_COUNT[key] ?? 0);

    if (!seen && !debug) {
      console.log(
        `🌱 First run for ${heading} — seeding ${items.length} item(s), posting ${newItems.length}`
      );
    } else if (!debug) {
      console.log(`ℹ️ ${heading}: ${newItems.length} new item(s)`);
    }

    nextSeen[key] = mergeSeen(items, seen);
    if (newItems.length) newByCategory.set(key, newItems);
  }

  // One request per new item decides available vs "(image unavailable)", and downloads the
  // artwork for attaching. Plain HTTPS against the asset CDN — no Chrome needed.
  for (const items of newByCategory.values()) {
    for (const item of items) item.image = await downloadItemImage(item);
  }

  // Items posted earlier without artwork get the same check; the ones that answer now are
  // reposted under their category, after whatever is new there. Debug leaves the list alone.
  const landedByCategory = new Map();
  const stillAwaiting = [];
  if (!debug) {
    const expiry = Date.now() - AWAITING_ART_MAX_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of awaitingArt) {
      if (Date.parse(entry.since) < expiry) {
        console.log(`⌛ Giving up on artwork for "${entry.name}" — still missing after ${AWAITING_ART_MAX_DAYS} days`);
        continue;
      }
      // The page's current record wins over the stored URL, in case the wiki has since fixed it.
      const current = byCategory.get(entry.category)?.find((item) => item.itemId === entry.itemId);
      const item = {
        itemId: entry.itemId,
        name: current?.name ?? entry.name,
        imageUrl: current?.imageUrl || entry.imageUrl,
        artLanded: true,
      };
      item.image = await downloadItemImage(item);
      if (!item.image) {
        stillAwaiting.push(entry);
        continue;
      }
      console.log(`🖼️ Artwork landed for "${item.name}" — reposting it`);
      landedByCategory.set(entry.category, [...(landedByCategory.get(entry.category) ?? []), item]);
    }

    const since = new Date().toISOString();
    for (const [category, items] of newByCategory) {
      for (const { itemId, name, imageUrl, image } of items) {
        if (!image && imageUrl) stillAwaiting.push({ category, itemId, name, imageUrl, since });
      }
    }
  }

  // Sections are built in COLLECTIBLE_CATEGORIES order so the post's headings always read
  // Dice Skins → Shields → Tokens, whichever categories happen to have something to show.
  const sections = COLLECTIBLE_CATEGORIES
    .map(({ key, heading }) => ({
      heading,
      items: [...(newByCategory.get(key) ?? []), ...(landedByCategory.get(key) ?? [])],
    }))
    .filter((section) => section.items.length);

  if (!sections.length) {
    console.log("ℹ️ No new collectibles to post");
    // Still recorded: this is what makes a first run seed silently, and it keeps the stored
    // ids tracking page 1 as newer items arrive.
    if (!debug) await recordState(client, seenByCategory, nextSeen, stillAwaiting);
    return;
  }

  const posted = await sendSpoilerPost({ client, sections, debug });
  if (!posted) return; // send failed — leave state untouched so the next run retries

  if (!debug) await recordState(client, seenByCategory, nextSeen, stillAwaiting);
  console.log("🏁 Finished collectible spoilers check\n");
};

/**
 * Whether a page-1 item is new to a category whose remembered ids are `seen`. Beyond "not in
 * the list", an id below the oldest one remembered predates every wave this job has tracked,
 * so it's old even if it was never on page 1 while this job was looking — a backstop for
 * back-catalogue items the remembered list itself can't vouch for.
 * @param {{ itemId: number }} item
 * @param {number[]} seen
 * @returns {boolean}
 */
function isNewItem(item, seen) {
  if (seen.includes(item.itemId)) return false;
  return !seen.length || item.itemId > Math.min(...seen);
}

/**
 * The category's remembered ids after this run: page 1 in page order, then everything
 * remembered before that isn't on it, capped at SEEN_CAP (the oldest-remembered fall off).
 * @param {Array<{ itemId: number }>} items - this run's page 1
 * @param {number[]} [seen]
 * @returns {number[]}
 */
function mergeSeen(items, seen = []) {
  return [...new Set([...items.map((item) => item.itemId), ...seen])].slice(0, SEEN_CAP);
}

/**
 * Write this run's state: the per-category id lists merged into db.lastPosts.spoilers
 * (categories absent from `nextSeen` — their page failed — keep whatever was stored), and
 * the items still waiting on artwork.
 * @param {import('discord.js').Client} client
 * @param {Record<string, number[]>} seenByCategory - state as read at the start of the run
 * @param {Record<string, number[]>} nextSeen - ids remembered after this run, per category
 * @param {Array<{ category: string, itemId: number, name: string, imageUrl: string, since: string }>} awaitingArt
 */
async function recordState(client, seenByCategory, nextSeen, awaitingArt) {
  await updateLastPosts(client, {
    spoilers: { ...seenByCategory, ...nextSeen },
    spoilersAwaitingArt: awaitingArt,
  });
}

/**
 * Rebuild the awaiting-artwork list from the spoilers channel, for a db written before the
 * list existed. Reads the bot's own recent posts for "(image unavailable)" lines — both the
 * current plain-message shape (`__Heading__` / `- Name _(image unavailable)_`) and the embed
 * the post used to be (a `__**Heading**__` field of `• Name ...` lines) — and matches each
 * name against its category's page 1 for the id and image URL. A name no longer on page 1 is
 * left out: it's 30 items old, long past being a spoiler.
 * @param {import('discord.js').Client} client
 * @param {Map<string, Array<{ itemId: number, name: string, imageUrl: string }>>} byCategory
 * @returns {Promise<Array<{ category: string, itemId: number, name: string, imageUrl: string, since: string }>>}
 */
async function seedAwaitingArtFromChannel(client, byCategory) {
  const channel = await client.channels.fetch(SPOILERS_CHANNEL_ID).catch(() => null);
  const messages = await channel?.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) {
    console.warn("⚠️ Couldn't read the spoilers channel to find items posted without artwork");
    return [];
  }

  const categoryByHeading = new Map(COLLECTIBLE_CATEGORIES.map((c) => [c.heading.toLowerCase(), c.key]));
  const found = new Map();
  for (const msg of messages.values()) {
    if (msg.author?.id !== client.user.id) continue;
    const blocks = [msg.content ?? "", ...msg.embeds.flatMap((e) => e.fields.map((f) => `${f.name}\n${f.value}`))];

    for (const block of blocks) {
      let category = null;
      for (const line of block.split("\n").map((l) => l.trim())) {
        const heading = line.match(/^__(?:\*\*)?(.+?)(?:\*\*)?__$/);
        if (heading) {
          category = categoryByHeading.get(heading[1].toLowerCase()) ?? null;
          continue;
        }
        const name = line.match(/^[-•]\s+(.+?)\s+_\(image unavailable\)_$/)?.[1];
        if (!category || !name) continue;

        for (const item of byCategory.get(category) ?? []) {
          if (item.name.toLowerCase() !== name.toLowerCase()) continue;
          found.set(`${category}:${item.itemId}`, {
            category,
            itemId: item.itemId,
            name: item.name,
            imageUrl: item.imageUrl,
            since: msg.createdAt.toISOString(),
          });
        }
      }
    }
  }

  console.log(`🗂️ Found ${found.size} earlier item(s) posted without artwork to keep checking`);
  return [...found.values()];
}

/**
 * Build and send the post: one plain message per category — its `__Heading__` and a bulleted
 * name list — with that category's artwork attached, so each grid sits under its own list.
 * The `## Upcoming Collectibles 👀?` title and source link lead the first category's message.
 *
 * Plain messages rather than an embed because an embed always renders below a message's
 * attachments and holds one list for the whole post, so the images couldn't be interleaved
 * with their categories. A category with more than MAX_ATTACHMENTS_PER_MESSAGE images
 * continues in attachment-only messages before the next category starts.
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

  const header = `## Upcoming Collectibles 👀?\nsource: <${COLLECTIBLES_SOURCE_URL}>\n\n`;
  let fileCount = 0;
  try {
    for (const [i, { heading, items }] of sections.entries()) {
      const list = items
        .map((item) => `- ${item.name}${item.image ? (item.artLanded ? ART_LANDED_NOTE : "") : " _(image unavailable)_"}`)
        .join("\n");
      const content = trimTo(`${i === 0 ? header : ""}__${heading}__\n${list}`, 2000);

      const files = items
        .filter((item) => item.image)
        .map((item) => new AttachmentBuilder(item.image.data, { name: item.image.name }));
      fileCount += files.length;

      const batches = chunk(files, MAX_ATTACHMENTS_PER_MESSAGE);
      await channel.send({ content, files: batches[0] ?? [] });
      for (const batch of batches.slice(1)) await channel.send({ files: batch });
    }
  } catch (err) {
    console.error("💥 Failed to post collectible spoilers:", err?.message || err);
    return false;
  }

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  console.log(
    `✅ Posted ${total} collectible(s) (${fileCount} image(s)) to ${debug ? "TEST_CHANNEL_ID" : "the spoilers channel"}=${channelId}`
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

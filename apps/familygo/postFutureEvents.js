import { AttachmentBuilder } from "discord.js";
import { getMogoWikiNews, getNewsIndexPosts, selectPostsSinceMarker, searchedEntry } from "./getFutureEvents.js";
import { fetchManyWithPlaywright } from "../../util/fetchWithPlaywright.js";
import { outputToFile } from "../../util/outputToFile.js";
import { parseFutureEventPost } from "./parseFutureEventPost.js";
import { fetchPostedHaystack, haystackHasUrl } from "./alreadyPosted.js";
import { getLastPosts, updateLastPosts } from "./db.js";

// Live channels for /future-events posts. Hardcoded (not env-based) per request.
const FUTURE_EVENTS_CHANNEL_ID = "1393942240300372008";
const SPECIAL_EVENTS_CHANNEL_ID = "1393942240300372008"; // 🏆 special-events
const GOLDEN_BLITZ_CHANNEL_ID = "1398027599472754822";
const ALBUM_PREVIEWS_CHANNEL_ID = "1449448347965460553";

/** Discord's per-message caps; anything past them spills into follow-up messages. */
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

// Maps a post's category tag (from parseFutureEventPost's `tags`) to a target channel
// and an optional emoji wrapped around the post's title in the message content (the wiki
// post title already names the event, so there's no separate heading line). Checked in
// this order; the first tag on a post that has a route wins.
const CATEGORY_ROUTES = {
  "dig-minigame": {
    channelId: SPECIAL_EVENTS_CHANNEL_ID,
    emoji: "<:dig_pickaxe:1538289771686928465>",
  },
  "prize-drop": {
    channelId: SPECIAL_EVENTS_CHANNEL_ID,
    emoji: "<:prize_drop:1531717495533076560>",
  },
  "tycoon-racers": {
    channelId: SPECIAL_EVENTS_CHANNEL_ID,
    emoji: "<:RaceCup_Currency_Icon:1441936191870992454>",
  },
  "partner-events": {
    channelId: SPECIAL_EVENTS_CHANNEL_ID,
    emoji: "<:high_five:1533293260678627448>",
  },
  "adventure-club": {
    channelId: SPECIAL_EVENTS_CHANNEL_ID,
    emoji: "<:AdventureEvent_Icon_Commodity:1489742463345234091>",
  },
  "blocks-boutique": {
    channelId: SPECIAL_EVENTS_CHANNEL_ID,
    emoji: "<:blocks_boutique:1529168959092424901>",
  },
  "golden-blitz": {
    channelId: GOLDEN_BLITZ_CHANNEL_ID,
    emoji: "<:GoldenBlitz:1437570226966495373>",
  },
  "sticker-albums": { channelId: ALBUM_PREVIEWS_CHANNEL_ID, emoji: null },
  albums: { channelId: ALBUM_PREVIEWS_CHANNEL_ID, emoji: null },
};

// Every channel a post can land in. The already-posted check runs before a post's tags (and
// therefore its route) are known, so it has to scan all of them.
const ALL_TARGET_CHANNEL_IDS = [
  ...new Set([FUTURE_EVENTS_CHANNEL_ID, ...Object.values(CATEGORY_ROUTES).map((r) => r.channelId)]),
];

/**
 * Sweep the Monopoly GO Wiki news index for new articles and post one Discord message
 * group per article, routed to a channel/emoji by category tag (see CATEGORY_ROUTES) and
 * falling back to FUTURE_EVENTS_CHANNEL_ID.
 *
 * What counts as "new" is measured from the wiki's own "Today's Events" posts rather than
 * from calendar dates (see selectPostsSinceMarker): everything newer than the marker the
 * previous run stopped at, minus the posts that run already looked at. Both live in
 * db.lastPosts.newsSweep as `{ cutoff, searched }`, so the 7:30pm cron and a manual
 * /future-events afterwards (say, for an article that landed at 9pm) each only handle
 * what the other hasn't. The channel scan (alreadyPosted.js) is the second dedupe layer
 * underneath, so a lost db write still can't double-post.
 *
 * Every candidate's page is fetched through one browser launch, since each launch is a
 * visible Chrome window on the packaged desktop build.
 *
 * @param {import('discord.js').Client} client - A logged-in Discord client.
 * @param {{ debug?: boolean }} [opts]
 *  - debug: post to process.env.TEST_CHANNEL_ID instead of the hardcoded live channels,
 *    turn on fetch-layer debug output (verbose logs + HTML dumps to disk), and bypass the
 *    searched list and the channel scan (and never record anything) so a manual run always
 *    produces messages to eyeball.
 */
export const postFutureEventsToDiscord = async (client, opts = {}) => {
  const { debug = false } = opts;

  console.log(`🌀 Starting postFutureEventsToDiscord${debug ? " (debug → test channel)" : ""}`);

  const newsHtml = await getMogoWikiNews({ debug });
  if (!newsHtml) {
    console.error("❌ Unable to retrieve HTML from Mogo Wiki News page");
    return;
  }

  const cards = getNewsIndexPosts(newsHtml, { debug });
  if (!cards.length) {
    console.error("❌ No posts found on the news index (page layout changed?)");
    return;
  }

  const state = debug ? {} : readSweepState(await getLastPosts(client));
  const { candidates, skipped, latestMarker, lowerBound } = selectPostsSinceMarker(cards, state, {
    ignoreSearched: debug,
  });
  if (!lowerBound) {
    console.warn('⚠️ No "Today\'s Events" post on the news index and no stored cutoff — nothing to measure from');
    return;
  }
  console.log(
    `📍 Looking at posts after ${lowerBound.toISOString()}` +
      (latestMarker ? ` (newest marker: "${latestMarker.title}" at ${latestMarker.publishDate.toISOString()})` : "") +
      ` — ${candidates.length} to check, ${skipped.length} already searched`
  );

  // `handled` is what the next run may skip; a post whose page couldn't be fetched or posted
  // is left out so it is looked at again.
  const handled = [...skipped];
  const failed = [];

  // Checked before fetching each post page, so an already-posted article costs one string
  // lookup instead of a page load. Keyed on the URL alone: the posted embed's timestamp
  // comes from the article's metadata, which doesn't always agree with the index date.
  let toFetch = candidates;
  if (!debug && candidates.length) {
    const posted = await fetchPostedHaystack(client, ALL_TARGET_CHANNEL_IDS);
    toFetch = [];
    for (const card of candidates) {
      if (haystackHasUrl(posted, card.url)) {
        console.log(`ℹ️ Already in a target channel: ${card.title}`);
        handled.push(card);
      } else {
        toFetch.push(card);
      }
    }
  }

  if (toFetch.length) {
    console.log(`🔗 Fetching ${toFetch.length} post page(s): ${toFetch.map((c) => c.url).join(", ")}`);
    let htmls;
    try {
      htmls = await fetchManyWithPlaywright(toFetch.map((c) => c.url));
    } catch (err) {
      console.error("💥 Browser launch failed, no post pages fetched:", err?.message || err);
      htmls = toFetch.map(() => null);
    }

    for (let i = 0; i < toFetch.length; i++) {
      const card = toFetch[i];
      const html = htmls[i];
      if (!html) {
        console.error(`❌ Unable to fetch post page: ${card.url}`);
        failed.push(card);
        continue;
      }
      try {
        if (debug) await outputToFile("./debug/monopolygo-future-event.html", html);
        const data = parseFutureEventPost(html, { sourceUrl: card.url });
        await postFutureEvent(client, data, { debug });
        console.log(`✅ Posted: ${data.title}`);
        handled.push(card);
      } catch (err) {
        console.error(`💥 Failed to process/post ${card.url}:`, err);
        failed.push(card);
      }
    }
  } else {
    console.log("ℹ️ Nothing new to post");
  }

  if (!debug) await recordSweep(client, state, { handled, failed, latestMarker, lowerBound });

  console.log("🏁 Finished postFutureEventsToDiscord\n");
};

/**
 * db.lastPosts.newsSweep, defensively: a db written before the sweep state existed (or
 * hand-edited) yields an empty state, which selectPostsSinceMarker treats as a first run.
 * @param {object} lastPosts
 * @returns {{ cutoff: string|null, searched: Array<{ key: string, at: string }> }}
 */
function readSweepState(lastPosts) {
  const s = lastPosts?.newsSweep;
  return {
    cutoff: typeof s?.cutoff === "string" ? s.cutoff : null,
    searched: Array.isArray(s?.searched)
      ? s.searched.filter((e) => e && typeof e.key === "string" && typeof e.at === "string")
      : [],
  };
}

/**
 * Write the sweep state for the next run.
 *
 * The cutoff advances to the newest "Today's Events" marker only when every candidate was
 * resolved (posted, or found already posted); a failed page fetch keeps it where it is so
 * the next run sees that post again, and the searched list is what stops the resolved
 * ones from being re-fetched in the meantime. Entries older than the cutoff are dropped,
 * so the list never holds more than a day or two of posts. Skipped when nothing changed,
 * since every db write is a new message in the db channel.
 */
async function recordSweep(client, state, { handled, failed, latestMarker, lowerBound }) {
  let cutoff = state.cutoff ?? lowerBound.toISOString();
  if (!failed.length && latestMarker && latestMarker.publishDate > lowerBound) {
    cutoff = latestMarker.publishDate.toISOString();
  }
  if (failed.length) {
    console.warn(`⚠️ ${failed.length} post(s) unresolved — keeping the cutoff at ${cutoff} so they're retried`);
  }

  const cutoffMs = new Date(cutoff).getTime();
  const merged = new Map();
  for (const entry of [...state.searched, ...handled.map(searchedEntry)]) {
    if (new Date(entry.at).getTime() > cutoffMs) merged.set(`${entry.key}@${entry.at}`, entry);
  }
  const searched = [...merged.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const next = { cutoff, searched };
  const previous = { cutoff: state.cutoff, searched: [...state.searched].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)) };
  if (JSON.stringify(next) === JSON.stringify(previous)) return;

  await updateLastPosts(client, { newsSweep: next });
}

/** The CATEGORY_ROUTES key for a post's first routed tag, or "general" (no route). */
function resolveCategoryKey(tags) {
  for (const tag of tags || []) {
    if (CATEGORY_ROUTES[tag]) return tag;
  }
  return "general";
}

/**
 * Post one article as a group of messages:
 *
 *  1. `# title` (emoji on both ends when the route has one) with the hero embed and the
 *     article's standalone images stacked underneath as image embeds — the first message
 *     holds as many as Discord allows, the rest follow ten per message, so nothing is
 *     dropped however long the article is.
 *  2. One message per image gallery, headed by the gallery's `## heading` (an album preview's
 *     "Monster Mash Sticker Sets", say) with its images as attachments, which Discord
 *     clusters into a grid — an embed can't do that, and the stacked look is wrong for a
 *     wheel of sticker sets.
 */
async function postFutureEvent(client, data, opts = {}) {
  const { debug = false } = opts;
  const route = CATEGORY_ROUTES[resolveCategoryKey(data.tags)] ?? null;
  const channelId = debug ? process.env.TEST_CHANNEL_ID : route?.channelId || FUTURE_EVENTS_CHANNEL_ID;
  if (!channelId) throw new Error("[postFutureEvent] Missing target channel ID");

  const channel = await client.channels.fetch(channelId);

  const mainEmbed = {
    title: data.title,
    url: data.url,
    image: data.heroImage ? { url: data.heroImage } : undefined,
    timestamp: data.publishDate ? data.publishDate.toISOString() : undefined,
    footer: { text: "monopolygo.wiki" },
  };

  // No `url` field here on purpose: Discord groups consecutive embeds that share the same
  // `url` into a side-by-side image gallery. Leaving it unset makes each embed stand alone,
  // so they stack vertically instead.
  const imageEmbeds = data.editorialImages.map((url) => ({ image: { url } }));

  // Embed titles don't render markdown, so the big-header styling has to live in the
  // message content — the embed keeps its own (plain) title as the clickable link.
  const emoji = route?.emoji;
  const content = emoji ? `# ${emoji} ${data.title} ${emoji}` : `# ${data.title}`;

  const [firstBatch, ...restBatches] = chunk([mainEmbed, ...imageEmbeds], MAX_EMBEDS_PER_MESSAGE);
  await channel.send({ content, embeds: firstBatch });
  for (const batch of restBatches) await channel.send({ embeds: batch });

  for (const gallery of data.galleries) await postGallery(channel, gallery);
}

/**
 * One gallery as a `## heading` message with its images attached. An image whose download
 * fails rides along as an embed instead, so a CDN hiccup costs the grid, not the picture.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {{ heading: string|null, images: string[] }} gallery
 */
async function postGallery(channel, gallery) {
  const files = [];
  const fallbackEmbeds = [];
  for (const url of gallery.images) {
    const file = await downloadImage(url);
    if (file) files.push(file);
    else fallbackEmbeds.push({ image: { url } });
  }

  const fileBatches = chunk(files, MAX_ATTACHMENTS_PER_MESSAGE);
  const embedBatches = chunk(fallbackEmbeds, MAX_EMBEDS_PER_MESSAGE);
  const messages = Math.max(fileBatches.length, embedBatches.length);
  for (let i = 0; i < messages; i++) {
    const payload = { files: fileBatches[i] ?? [], embeds: embedBatches[i] ?? [] };
    if (i === 0 && gallery.heading) payload.content = `## ${gallery.heading}`;
    await channel.send(payload);
  }
}

/**
 * Download an image for attaching, or null when it can't be had (a 404 from the CDN is
 * an HTML error page, so the status is checked rather than the body trusted).
 * @param {string} url
 * @returns {Promise<AttachmentBuilder|null>}
 */
async function downloadImage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`🚫 Image unavailable (${res.status}): ${url}`);
      return null;
    }
    const data = Buffer.from(await res.arrayBuffer());
    return new AttachmentBuilder(data, { name: attachmentName(url) });
  } catch (err) {
    console.warn(`⚠️ Couldn't download image ${url}:`, err?.message || err);
    return null;
  }
}

/** The URL's file name, reduced to characters Discord accepts, e.g. "album-set-1-blog-5004eaff.png". */
function attachmentName(url) {
  let base = "image.png";
  try {
    base = new URL(url).pathname.split("/").filter(Boolean).pop() || base;
  } catch {
    // keep the default
  }
  return base.replace(/[^A-Za-z0-9._-]+/g, "-");
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

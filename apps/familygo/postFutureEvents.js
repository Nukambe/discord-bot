import { getMogoWikiNews, getFutureEventPosts } from "./getFutureEvents.js";
import { getMogoEventPage } from "./getEvents.js";
import { parseFutureEventPost } from "./parseFutureEventPost.js";
import { getFreeDiceLinks } from "./getFreeDiceLinks.js";
import { getYesterdayEstDateString } from "../../util/dateUtils.js";

const FREE_DICE_LINKS_URL = "https://monopolygo.wiki/latest-reward-links";

// Live channels for /future-events posts. Hardcoded (not env-based) per request — fill in.
const FUTURE_EVENTS_CHANNEL_ID = "1393942240300372008";
const FREE_DICE_LINKS_CHANNEL_ID = "1390326248055767184";
const SPECIAL_EVENTS_CHANNEL_ID = "1393942240300372008"; // 🏆 special-events
const GOLDEN_BLITZ_CHANNEL_ID = "1398027599472754822";
const ALBUM_PREVIEWS_CHANNEL_ID = "1449448347965460553";

// 1 main embed (hero image) + up to this many image-only embeds = Discord's 10-embed cap.
const MAX_EXTRA_IMAGE_EMBEDS = 9;

// Maps a post's category tag (from parseFutureEventPost's `tags`) to a target channel
// and an optional banner line prepended to the message content. Checked in this order;
// the first tag on a post that has a route wins.
const CATEGORY_ROUTES = {
  "dig-minigame": {
    channelId: SPECIAL_EVENTS_CHANNEL_ID,
    banner: "<:Dig_Tool:1437570228421791855> UPCOMING DIG TREASURES <:Dig_Tool:1437570228421791855>",
  },
  "prize-drop": {
    channelId: SPECIAL_EVENTS_CHANNEL_ID,
    banner: "<:prize_drop:1531717495533076560> UPCOMING PRIZE DROP <:prize_drop:1531717495533076560>",
  },
  "tycoon-racers": {
    channelId: SPECIAL_EVENTS_CHANNEL_ID,
    banner:
      "<:RaceCup_Currency_Icon:1441936191870992454> UPCOMING RACERS <:RaceCup_Currency_Icon:1441936191870992454>",
  },
  "partner-events": {
    channelId: SPECIAL_EVENTS_CHANNEL_ID,
    banner: "<:high_five:1531689502098063500> UPCOMING PARTNERS <:high_five:1531689502098063500>",
  },
  "adventure-club": {
    channelId: SPECIAL_EVENTS_CHANNEL_ID,
    banner:
      "<:AdventureEvent_Icon_Commodity:1489742463345234091> UPCOMING ADVENTURES <:AdventureEvent_Icon_Commodity:1489742463345234091>",
  },
  "golden-blitz": {
    channelId: GOLDEN_BLITZ_CHANNEL_ID,
    banner: "<:GoldenBlitz:1437570226966495373> UPCOMING GOLDEN BLITZ <:GoldenBlitz:1437570226966495373>",
  },
  "sticker-albums": { channelId: ALBUM_PREVIEWS_CHANNEL_ID, banner: null },
  albums: { channelId: ALBUM_PREVIEWS_CHANNEL_ID, banner: null },
};

/**
 * Find yesterday's (America/New_York) Monopoly GO Wiki news posts — excluding the daily
 * "Today's Events" posts, which are handled by the separate daily-events cron/command —
 * and post one Discord message per post. The "Free Dice Links Today" post gets special
 * handling: one message per individual reward link that first became available on the
 * target date (see postFreeDiceLinks). Other posts route to a channel/banner based on
 * their category tag (see CATEGORY_ROUTES), falling back to FUTURE_EVENTS_CHANNEL_ID.
 *
 * @param {import('discord.js').Client} client - A logged-in Discord client.
 * @param {{ debug?: boolean }} [opts]
 *  - debug: post to process.env.TEST_CHANNEL_ID instead of the hardcoded live channels,
 *    and turn on fetch-layer debug output (verbose logs + HTML dumps to disk).
 */
export const postFutureEventsToDiscord = async (client, opts = {}) => {
  const { debug = false } = opts;
  const targetEstDate = getYesterdayEstDateString();

  console.log(
    `🌀 Starting postFutureEventsToDiscord for ${targetEstDate}${debug ? " (debug → test channel)" : ""}`
  );

  const newsHtml = await getMogoWikiNews({ debug });
  if (!newsHtml) {
    console.error("❌ Unable to retrieve HTML from Mogo Wiki News page");
    return;
  }

  const posts = getFutureEventPosts(newsHtml, targetEstDate, { debug });
  if (!posts.length) {
    console.log(`ℹ️ No future-event posts found for ${targetEstDate}`);
    return;
  }
  console.log(`🔗 Found ${posts.length} post(s) for ${targetEstDate}`);

  for (const post of posts) {
    try {
      if (post.url.replace(/\/$/, "") === FREE_DICE_LINKS_URL) {
        await postFreeDiceLinks(client, post.url, targetEstDate, { debug });
        continue;
      }

      const postHtml = await getMogoEventPage(post.url, { debug });
      if (!postHtml) {
        console.error(`❌ Unable to fetch post page: ${post.url}`);
        continue;
      }

      const data = parseFutureEventPost(postHtml, { sourceUrl: post.url });
      await postFutureEvent(client, data, { debug });
      console.log(`✅ Posted: ${data.title}`);
    } catch (err) {
      console.error(`💥 Failed to process/post ${post.url}:`, err);
    }
  }

  console.log("🏁 Finished postFutureEventsToDiscord\n");
};

function resolveCategoryRoute(tags) {
  for (const tag of tags || []) {
    if (CATEGORY_ROUTES[tag]) return CATEGORY_ROUTES[tag];
  }
  return null;
}

async function postFutureEvent(client, data, opts = {}) {
  const { debug = false } = opts;
  const route = resolveCategoryRoute(data.tags);
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

  const imageEmbeds = data.editorialImages
    .slice(0, MAX_EXTRA_IMAGE_EMBEDS)
    .map((url) => ({ url: data.url, image: { url } }));

  await channel.send({ content: route?.banner || "", embeds: [mainEmbed, ...imageEmbeds] });
}

async function postFreeDiceLinks(client, postUrl, targetEstDate, opts = {}) {
  const { debug = false } = opts;

  const html = await getMogoEventPage(postUrl, { debug });
  if (!html) {
    console.error(`❌ Unable to fetch free dice links page: ${postUrl}`);
    return;
  }

  const links = getFreeDiceLinks(html, targetEstDate, { debug });
  if (!links.length) {
    console.log(`ℹ️ No newly-available free dice links for ${targetEstDate}`);
    return;
  }

  const channelId = debug ? process.env.TEST_CHANNEL_ID : FREE_DICE_LINKS_CHANNEL_ID;
  if (!channelId) throw new Error("[postFreeDiceLinks] Missing target channel ID");
  const channel = await client.channels.fetch(channelId);

  for (const link of links) {
    await channel.send({ content: formatFreeDiceLinkContent(link) });
    console.log(`✅ Posted free dice link: ${link.claimUrl}`);
  }
}

function formatFreeDiceLinkContent(link) {
  const label =
    link.rewardName.toLowerCase() === "rolls" ? "🎲 FREE DICE" : `🎁 FREE ${link.rewardName.toUpperCase()}`;
  const validUntil = link.endDate ? formatEstDateTime(link.endDate) : "Unknown";

  return [
    `${link.quantity} ${label}`,
    `Valid until: ${validUntil}`,
    "",
    link.claimUrl,
    "",
    "These links are confirmed to be working. Please keep in mind that they do expire.",
  ].join("\n");
}

// Formats a Date as "August 3, 2026 11:27 AM" in America/New_York. Uses typed parts
// (see toEstDateString in util/dateUtils.js) rather than a locale-formatted string, for
// the same reason: the packaged/pkg build's Node runtime formats locale strings
// differently than plain Node.
function formatEstDateTime(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.month} ${map.day}, ${map.year} ${map.hour}:${map.minute} ${map.dayPeriod}`;
}

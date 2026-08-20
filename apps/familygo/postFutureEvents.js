import { getMogoWikiNews, getFutureEventPosts } from "./getFutureEvents.js";
import { getMogoEventPage } from "./getEvents.js";
import { parseFutureEventPost } from "./parseFutureEventPost.js";
import { toEstDateString, getYesterdayEstDateString } from "../../util/dateUtils.js";
import { fetchPostedHaystack, haystackHasUrl } from "./alreadyPosted.js";

// Live channels for /future-events posts. Hardcoded (not env-based) per request.
const FUTURE_EVENTS_CHANNEL_ID = "1393942240300372008";
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
    banner: "<:dig_pickaxe:1538289771686928465> UPCOMING DIG TREASURES <:dig_pickaxe:1538289771686928465>",
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
    banner: "<:high_five:1533293260678627448> UPCOMING PARTNERS <:high_five:1533293260678627448>",
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

// Every channel a post can land in. The already-posted check runs before a post's tags (and
// therefore its route) are known, so it has to scan all of them.
const ALL_TARGET_CHANNEL_IDS = [
  ...new Set([FUTURE_EVENTS_CHANNEL_ID, ...Object.values(CATEGORY_ROUTES).map((r) => r.channelId)]),
];

/**
 * Find today's and yesterday's (America/New_York) Monopoly GO Wiki news posts — excluding
 * the daily "Today's Events" posts, which are handled by the separate daily-events
 * cron/command, and the "Free Dice Links Today" post, which is handled by
 * postNewFreeDiceLinks — and post one Discord message per post. Each post routes to a
 * channel/banner based on its category tag (see CATEGORY_ROUTES), falling back to
 * FUTURE_EVENTS_CHANNEL_ID.
 *
 * The window covers two days rather than just "yesterday" so that the scheduled midnight run
 * (startFutureEventsCron in index.js) and any manual /future-events run overlap instead of
 * each carving out a separate day — the wiki publishes preview articles late in the Eastern
 * evening (the Roll Treasures guide went up at 23:46 EST), which is exactly where a
 * single-day window has its seam. Deduping on the post URL against what's already in the
 * target channels is what makes overlapping runs safe.
 *
 * @param {import('discord.js').Client} client - A logged-in Discord client.
 * @param {{ debug?: boolean }} [opts]
 *  - debug: post to process.env.TEST_CHANNEL_ID instead of the hardcoded live channels,
 *    turn on fetch-layer debug output (verbose logs + HTML dumps to disk), and bypass the
 *    already-posted check so a manual run always produces messages to eyeball.
 */
export const postFutureEventsToDiscord = async (client, opts = {}) => {
  const { debug = false } = opts;
  const targetEstDates = [toEstDateString(new Date()), getYesterdayEstDateString()];
  const window = targetEstDates.join(" / ");

  console.log(
    `🌀 Starting postFutureEventsToDiscord for ${window}${debug ? " (debug → test channel)" : ""}`
  );

  const newsHtml = await getMogoWikiNews({ debug });
  if (!newsHtml) {
    console.error("❌ Unable to retrieve HTML from Mogo Wiki News page");
    return;
  }

  const found = getFutureEventPosts(newsHtml, targetEstDates, { debug });
  if (!found.length) {
    console.log(`ℹ️ No future-event posts found for ${window}`);
    return;
  }

  // Checked before fetching each post page, so an already-posted article costs one string
  // lookup instead of a browser launch — the two-day window mostly contains posts that
  // were already handled by the previous run.
  const posted = debug ? "" : await fetchPostedHaystack(client, ALL_TARGET_CHANNEL_IDS);
  const posts = found.filter((post) => !haystackHasUrl(posted, post.url));

  if (!posts.length) {
    console.log(`ℹ️ All ${found.length} post(s) for ${window} were already posted`);
    return;
  }
  console.log(`🔗 Found ${posts.length} new post(s) for ${window} (${found.length} in window)`);

  for (const post of posts) {
    try {
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

  // No `url` field here on purpose: Discord groups consecutive embeds that share the same
  // `url` into a side-by-side image gallery. Leaving it unset makes each embed stand alone,
  // so they stack vertically instead.
  const imageEmbeds = data.editorialImages
    .slice(0, MAX_EXTRA_IMAGE_EMBEDS)
    .map((url) => ({ image: { url } }));

  // Embed titles don't render markdown, so the big-header styling has to live in the
  // message content — the embed keeps its own (plain) title as the clickable link.
  const bannerLine = route?.banner ? `${route.banner}\n` : "";
  const content = `${bannerLine}# ${data.title}`;

  await channel.send({ content, embeds: [mainEmbed, ...imageEmbeds] });
}

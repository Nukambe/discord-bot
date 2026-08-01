import { getMogoWikiNews, getFutureEventPosts } from "./getFutureEvents.js";
import { getMogoEventPage } from "./getEvents.js";
import { parseFutureEventPost } from "./parseFutureEventPost.js";
import { getYesterdayEstDateString } from "../../util/dateUtils.js";

// Live channel for /future-events posts. Hardcoded (not env-based) per request — fill in.
const FUTURE_EVENTS_CHANNEL_ID = "1393942240300372008";

// 1 main embed (hero image) + up to this many image-only embeds = Discord's 10-embed cap.
const MAX_EXTRA_IMAGE_EMBEDS = 9;

/**
 * Find yesterday's (America/New_York) Monopoly GO Wiki news posts — excluding the daily
 * "Today's Events" posts, which are handled by the separate daily-events cron/command —
 * and post one Discord message per post.
 *
 * @param {import('discord.js').Client} client - A logged-in Discord client.
 * @param {{ debug?: boolean }} [opts]
 *  - debug: post to process.env.TEST_CHANNEL_ID instead of the hardcoded live channel,
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

async function postFutureEvent(client, data, opts = {}) {
  const { debug = false } = opts;
  const channelId = debug ? process.env.TEST_CHANNEL_ID : FUTURE_EVENTS_CHANNEL_ID;
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

  await channel.send({ embeds: [mainEmbed, ...imageEmbeds] });
}

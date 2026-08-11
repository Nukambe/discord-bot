import { getMogoEventPage } from "./getEvents.js";
import { getFreeDiceLinks } from "./getFreeDiceLinks.js";
import { toEstDateString } from "../../util/dateUtils.js";

const FREE_DICE_LINKS_URL = "https://monopolygo.wiki/latest-reward-links";

// Live channel for free dice link posts. Hardcoded (not env-based) per request.
const FREE_DICE_LINKS_CHANNEL_ID = "1390326248055767184";

/**
 * Fetch the Monopoly GO Wiki's "Free Dice Links Today" page and post one Discord message
 * per reward link that first became available today (America/New_York) — links that were
 * already available on a previous day were already posted then, so re-posting them here
 * would duplicate them. Runs as part of the daily-post flow (see postEventToDiscord in
 * index.js), so it fires once per day alongside the daily events post.
 *
 * @param {import('discord.js').Client} client - A logged-in Discord client.
 * @param {{ debug?: boolean }} [opts]
 *  - debug: post to process.env.TEST_CHANNEL_ID instead of the hardcoded live channel,
 *    and turn on fetch-layer debug output (verbose logs + HTML dumps to disk).
 */
export const postFreeDiceLinksForToday = async (client, opts = {}) => {
  const { debug = false } = opts;
  const targetEstDate = toEstDateString(new Date());

  console.log(`🎲 Checking free dice links for ${targetEstDate}${debug ? " (debug → test channel)" : ""}`);

  const html = await getMogoEventPage(FREE_DICE_LINKS_URL, { debug });
  if (!html) {
    console.error("❌ Unable to fetch free dice links page");
    return;
  }

  let links = getFreeDiceLinks(html, targetEstDate, { debug });
  let debugFallback = false;

  // Debug mode is used to visually check formatting/posting, which needs an actual
  // message in the channel — fall back to the first link on the page (regardless of
  // its date) rather than silently posting nothing.
  if (!links.length && debug) {
    const allLinks = getFreeDiceLinks(html, null, { debug });
    if (allLinks.length) {
      links = [allLinks[0]];
      debugFallback = true;
      console.log(`ℹ️ No newly-available free dice links for ${targetEstDate} — debug mode: posting first link on page instead`);
    }
  }

  if (!links.length) {
    console.log(`ℹ️ No newly-available free dice links for ${targetEstDate}`);
    return;
  }

  const channelId = debug ? process.env.TEST_CHANNEL_ID : FREE_DICE_LINKS_CHANNEL_ID;
  if (!channelId) throw new Error("[postFreeDiceLinksForToday] Missing target channel ID");
  const channel = await client.channels.fetch(channelId);

  for (const link of links) {
    await channel.send({ content: formatFreeDiceLinkContent(link, { debugFallback }) });
    console.log(`✅ Posted free dice link: ${link.claimUrl}`);
  }
};

function formatFreeDiceLinkContent(link, opts = {}) {
  const { debugFallback = false } = opts;
  const label =
    link.rewardName.toLowerCase() === "rolls" ? "🎲 FREE DICE" : `🎁 FREE ${link.rewardName.toUpperCase()}`;
  const validUntil = link.endDate ? formatEstDateTime(link.endDate) : "Unknown";

  return [
    debugFallback ? "-# 🧪 DEBUG FALLBACK: not necessarily today's link, shown so debug mode has something to check." : null,
    `### ${link.quantity} ${label}`,
    `Valid until: ${validUntil}`,
    "",
    link.claimUrl,
    "",
    "-# Free Dice links are from MOGO WIKI which is not affiliated with Scopely. Check the official MONOPOLY GO! 🎁 giveaways channel for links directly from Scopely.",
  ].filter(Boolean).join("\n");
}

// Formats a Date as "August 3, 2026 11:27 AM" in America/New_York. Uses typed parts
// (see toEstDateString in util/dateUtils.js) rather than a locale-formatted string, since
// the packaged/pkg build's Node runtime formats locale strings differently than plain Node.
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

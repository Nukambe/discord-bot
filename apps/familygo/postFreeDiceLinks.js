import { getMogoEventPage } from "./getEvents.js";
import { getFreeDiceLinks } from "./getFreeDiceLinks.js";
import { toEstDateString, getYesterdayEstDateString } from "../../util/dateUtils.js";
import { fetchPostedHaystack, haystackHasUrl } from "./alreadyPosted.js";

const FREE_DICE_LINKS_URL = "https://monopolygo.wiki/latest-reward-links";

// Live channel for free dice link posts. Hardcoded (not env-based) per request.
const FREE_DICE_LINKS_CHANNEL_ID = "1390326248055767184";

/**
 * Fetch the Monopoly GO Wiki's "Free Dice Links Today" page and post one Discord message
 * per reward link that became available today or yesterday (America/New_York) and isn't
 * already in the channel.
 *
 * The two-day window plus the already-posted check replaced a today-only filter, which
 * dropped links outright at the calendar boundary: a run landing just after midnight,
 * filtering on its own date, never looked back at the day that just ended. Scanning
 * yesterday as well closes that gap — consecutive runs overlap by a day no matter when
 * each one lands, and deduping on the claim URL is what keeps that overlap from
 * re-posting anything.
 *
 * Called from the daily 7:30pm cron (startFreeDiceCron in index.js) and the manual
 * /free-dice command, which exists to catch up on any links a scheduled run missed —
 * the overlap-plus-dedupe design is what makes re-running it at any time safe.
 *
 * @param {import('discord.js').Client} client - A logged-in Discord client.
 * @param {{ debug?: boolean }} [opts]
 *  - debug: post to process.env.TEST_CHANNEL_ID instead of the hardcoded live channel, turn
 *    on fetch-layer debug output (verbose logs + HTML dumps to disk), and bypass the
 *    already-posted check so a manual run always produces a message to eyeball.
 */
export const postNewFreeDiceLinks = async (client, opts = {}) => {
  const { debug = false } = opts;
  const targetEstDates = [toEstDateString(new Date()), getYesterdayEstDateString()];

  console.log(
    `🎲 Checking free dice links for ${targetEstDates.join(" / ")}${debug ? " (debug → test channel)" : ""}`
  );

  const html = await getMogoEventPage(FREE_DICE_LINKS_URL, { debug });
  if (!html) {
    console.error("❌ Unable to fetch free dice links page");
    return;
  }

  let links = getFreeDiceLinks(html, targetEstDates, { debug });
  let debugFallback = false;

  // Debug mode is used to visually check formatting/posting, which needs an actual
  // message in the channel — fall back to the first link on the page (regardless of
  // its date) rather than silently posting nothing.
  if (!links.length && debug) {
    const allLinks = getFreeDiceLinks(html, null, { debug });
    if (allLinks.length) {
      links = [allLinks[0]];
      debugFallback = true;
      console.log(`ℹ️ No new free dice links in window — debug mode: posting first link on page instead`);
    }
  }

  if (!links.length) {
    console.log(`ℹ️ No free dice links available for ${targetEstDates.join(" / ")}`);
    return;
  }

  const channelId = debug ? process.env.TEST_CHANNEL_ID : FREE_DICE_LINKS_CHANNEL_ID;
  if (!channelId) throw new Error("[postNewFreeDiceLinks] Missing target channel ID");
  const channel = await client.channels.fetch(channelId);

  const posted = debug ? "" : await fetchPostedHaystack(client, [channelId]);
  const fresh = links.filter((link) => !haystackHasUrl(posted, link.claimUrl));

  if (!fresh.length) {
    console.log(`ℹ️ All ${links.length} free dice link(s) in window were already posted`);
    return;
  }

  for (const link of fresh) {
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

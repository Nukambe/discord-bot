import { getMogoEventPage } from "./getEvents.js";
import { getFreeDiceLinks } from "./getFreeDiceLinks.js";
import { toEstDateString, getYesterdayEstDateString } from "../../util/dateUtils.js";
import { fetchPostedHaystack, haystackHasUrl, urlKey } from "./alreadyPosted.js";
import { resolveRewardLink } from "./resolveRewardLink.js";
import { getLastPosts, updateLastPosts } from "./db.js";

const FREE_DICE_LINKS_URL = "https://monopolygo.wiki/latest-reward-links";

// Live channel for free dice link posts. Hardcoded (not env-based) per request.
const FREE_DICE_LINKS_CHANNEL_ID = "1390326248055767184";

// How many recently posted links to remember in db.lastPosts.freeDice (one key each) —
// comfortably more than the two-day scan window can hold, while the channel scan covers the
// longer tail. Keep it well clear of the ceiling this list actually has: the whole db is
// JSON inside a single Discord message, and past 2000 characters updateLastPosts just fails
// its send and warns, silently dropping this layer of dedupe.
const FREE_DICE_STATE_LIMIT = 10;

/**
 * Fetch the Monopoly GO Wiki's "Free Dice Links Today" page and post one Discord message
 * per reward link that became available today or yesterday (America/New_York) and isn't
 * already in the channel.
 *
 * The two-day window plus the already-posted check replaced a today-only filter, which
 * dropped links outright at the calendar boundary: a run landing just after midnight,
 * filtering on its own date, never looked back at the day that just ended. Scanning
 * yesterday as well closes that gap — consecutive runs overlap by a day no matter when
 * each one lands, and deduping is what keeps that overlap from re-posting anything.
 *
 * That dedupe keys off the *resolved* link, not the one the wiki prints. The wiki wraps
 * Scopely's links in its own shortener and mints a new slug each time it re-lists a card,
 * so URL-keyed dedupe used to wave through rewards users had already claimed — a new link
 * to the same reward, which the game then rejects. resolveRewardLink.js unwraps each href
 * to Scopely's own mply.io link (that is what gets posted) and to the campaign id behind
 * it, either of which identifies the reward no matter how many slugs the wiki spends on it.
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

  // A card whose window has closed is a dead link — the page keeps showing it, but anyone
  // clicking it gets nothing. Dropped before the debug fallback so a debug run can still
  // fall back to something rather than being left with an empty list.
  const live = links.filter((link) => !link.endDate || link.endDate.getTime() >= Date.now());
  if (live.length !== links.length) {
    console.log(`ℹ️ Skipping ${links.length - live.length} expired free dice link(s)`);
    links = live;
  }

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

  // Unwrap the wiki's shortener before anything else looks at these: `claimUrl` becomes the
  // link we post and the link we dedupe on, `wikiUrl` is kept only so history that predates
  // this change (messages and db entries holding wrapper URLs) still matches.
  const resolved = await Promise.all(
    links.map(async (link) => {
      const { url, rewardId } = await resolveRewardLink(link.claimUrl, { debug });
      return { ...link, claimUrl: url, wikiUrl: link.claimUrl, rewardId };
    })
  );

  // The page itself can list one reward twice under two slugs, which only becomes visible
  // once they resolve — collapse those before posting.
  const unique = [];
  const seen = new Set();
  for (const link of resolved) {
    const key = link.rewardId ?? urlKey(link.claimUrl);
    if (seen.has(key)) {
      console.log(`ℹ️ Skipping duplicate listing of ${key}`);
      continue;
    }
    seen.add(key);
    unique.push(link);
  }

  // Two dedupe layers, both skipped in debug so a test run always posts: the channel scan
  // (survives db loss) and db.lastPosts.freeDice (keeps the 7:30pm cron and a manual
  // /free-dice run from double-posting each other's links, whichever ran first).
  const posted = debug ? "" : await fetchPostedHaystack(client, [channelId]);
  const storedKeys = debug ? [] : (await getLastPosts(client)).freeDice ?? [];
  const alreadyPosted = (link) =>
    haystackHasUrl(posted, link.claimUrl) ||
    haystackHasUrl(posted, link.wikiUrl) ||
    [urlKey(link.claimUrl), urlKey(link.wikiUrl), link.rewardId]
      .filter(Boolean)
      .some((key) => storedKeys.includes(key));
  const fresh = debug ? unique : unique.filter((link) => !alreadyPosted(link));

  if (!fresh.length) {
    console.log(`ℹ️ All ${unique.length} free dice link(s) in window were already posted`);
    return;
  }

  for (const link of fresh) {
    await channel.send({ content: formatFreeDiceLinkContent(link, { debugFallback }) });
    console.log(`✅ Posted free dice link: ${link.claimUrl} (id=${link.rewardId ?? "unresolved"})`);
  }

  if (!debug) {
    // Prefer the campaign id: it's the one key the wiki can't invalidate by re-shortening.
    // A link whose chain couldn't be resolved falls back to its URL key, which is no worse
    // than what this stored before. One key per link keeps the most links remembered
    // within the message-size budget above.
    const keys = [...storedKeys, ...fresh.map((link) => link.rewardId ?? urlKey(link.claimUrl))];
    await updateLastPosts(client, { freeDice: keys.slice(-FREE_DICE_STATE_LIMIT) });
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

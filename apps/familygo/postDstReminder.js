import { toEstDateString } from "../../util/dateUtils.js";
import { getLastPosts, updateLastPosts } from "./db.js";

// #general. Hardcoded (not env-based), like the other live channels.
const GENERAL_CHANNEL_ID = "1388290507578544241";

// Worded exactly as requested. The game's resets are fixed in UTC, so in Eastern time they
// land an hour later while daylight saving is on.
const MESSAGES = {
  begins:
    "## 🕐 Daylight Savings Begins\n" +
    "**A friendly reminder that quick wins reset at 9:00 and tournaments reset at 13:00. Be mindful of all other event schedules as well.**",
  ends:
    "## 🕛 Daylight Savings Ends\n" +
    "**A friendly reminder that quick wins reset at 8:00 and tournaments reset at 12:00. Be mindful of all other event schedules as well.**",
};

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * America/New_York's UTC offset in minutes at `ms` (-240 under EDT, -300 under EST): the
 * ET wall time read as if it were UTC, minus the instant. Built from typed Intl parts, not
 * `timeZoneName: "shortOffset"`, for the packaged build's sake (see util/dateUtils.js).
 */
const etOffsetMinutes = (ms) => {
  const map = {};
  for (const part of ET_PARTS.formatToParts(new Date(ms))) map[part.type] = part.value;
  const wall = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute);
  return Math.round((wall - Math.floor(ms / 60000) * 60000) / 60000);
};

/**
 * Whether daylight saving time begins or ends on the ET calendar day containing `now`.
 * Asks the timezone data rather than hardcoding "second Sunday in March / first in
 * November": the offset just after midnight is compared with the offset that evening, and
 * the clocks change at 2am, between the two.
 * @param {Date} [now]
 * @returns {"begins"|"ends"|null}
 */
export function dstChangeToday(now = new Date()) {
  const [year, month, day] = toEstDateString(now).split("-").map(Number);
  const morning = etOffsetMinutes(Date.UTC(year, month - 1, day, 5)); // 00:00 EST / 01:00 EDT
  const evening = etOffsetMinutes(Date.UTC(year, month - 1, day, 23)); // 18:00 EST / 19:00 EDT
  if (evening > morning) return "begins";
  if (evening < morning) return "ends";
  return null;
}

/**
 * Post the daylight-saving reminder to #general if the clocks change today and it hasn't
 * gone out yet. Runs from the midnight slot (the 'dst-reminder' job in index.js) every day
 * and does nothing on the 363 days without a change — no wiki fetch, no browser window.
 *
 * Dedupe is db.lastPosts.dst (the ET date last posted) rather than a channel scan: #general
 * is busy enough that a midnight post can scroll out of any scan window by the time a
 * restart's catch-up asks again.
 * @param {import('discord.js').Client} client
 */
export async function postDstReminder(client) {
  const change = dstChangeToday();
  if (!change) return;

  const today = toEstDateString(new Date());
  const { dst } = await getLastPosts(client);
  if (dst === today) return;

  const channel = await client.channels.fetch(GENERAL_CHANNEL_ID);
  await channel.send({ content: MESSAGES[change], allowedMentions: { parse: [] } });
  console.log(`🕐 Posted daylight saving reminder (${change}) for ${today}.`);
  await updateLastPosts(client, { dst: today });
}

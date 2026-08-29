import { getMogoWikiCalendar, getCalendarEvents } from "./getWeeklyEvents.js";
import { toEstDateString, toEstShortDateTime } from "../../util/dateUtils.js";
import { pickEmoji } from "./emojiMap.js";
import { fetchPostedHaystack } from "./alreadyPosted.js";
import { getLastPosts, updateLastPosts } from "./db.js";

const CALENDAR_URL = "https://monopolygo.wiki/events";

// Live channel for weekly predictions. Hardcoded (not env-based) per request.
const WEEKLY_CHANNEL_ID = "1446519556863430749";

// Weekly predictions exclude these calendar entry types — they're the always-running
// backbone events, not the flash schedule people plan around. Tested against both the
// record's event_key ("MilestoneEvent", "TycoonClassTournament") and its title.
const EXCLUDED_TYPES = /milestone|tournament/i;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The America/New_York date ("YYYY-MM-DD") of the Monday whose week the next
 * predictions post covers: tomorrow when run on a Sunday (the scheduled 7:30pm slot),
 * today when run on a Monday (the retry window spilling past midnight), otherwise the
 * next Monday ahead.
 * @param {Date} [now]
 * @returns {string}
 */
export function getUpcomingMondayEstDate(now = new Date()) {
  const [y, m, d] = toEstDateString(now).split("-").map(Number);
  const today = new Date(y, m - 1, d); // local midnight stand-in for the ET calendar date
  const daysUntilMonday = (8 - today.getDay()) % 7; // Sun→1, Mon→0, Tue→6, ... Sat→2
  const monday = new Date(y, m - 1, d + daysUntilMonday);
  return [
    monday.getFullYear(),
    String(monday.getMonth() + 1).padStart(2, "0"),
    String(monday.getDate()).padStart(2, "0"),
  ].join("-");
}

/** The 7 ET date strings ("YYYY-MM-DD") of the week starting at mondayDate. */
function weekDatesFrom(mondayDate) {
  const [y, m, d] = mondayDate.split("-").map(Number);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(y, m - 1, d + i);
    return [
      day.getFullYear(),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    ].join("-");
  });
}

/**
 * Day header rendered as an underlined markdown heading, e.g.
 * "## __🔮 Monday, 08/31/2026__". Also the channel-scan dedupe marker.
 * (`##` must come before the `__` — Discord only treats `##` as a heading at the
 * very start of the line.)
 */
function dayHeader(estDate) {
  const [y, m, d] = estDate.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `## __🔮 ${weekday}, ${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}__`;
}

/**
 * Build the post as one message per day that has events, e.g.:
 *
 *   ## __🔮 Monday, 08/31/2026__
 *   <:HighRoller:...> **High Roller** `Aug 31, 3:00 AM - Aug 31, 8:59 AM`
 *   <:prize_drop:...> **Peg-E Prize Drop** `Aug 31, 4:00 PM - Sep 2, 12:59 PM`
 *
 * Events are grouped by the ET calendar date they *start* on (so an event spilling
 * past midnight isn't repeated on its second day), and the last day's message carries
 * the source link.
 *
 * @param {Array<{ title: string, eventKey: string, start: Date, end: Date }>} events
 * @param {string[]} weekDates - 7 ET date strings, Monday through Sunday.
 * @returns {string[]} One string per day, each sent as its own Discord message.
 */
export function formatWeeklyPredictions(events, weekDates) {
  const byDay = new Map(weekDates.map((d) => [d, []]));
  for (const ev of events) {
    byDay.get(toEstDateString(ev.start))?.push(ev);
  }

  const blocks = [];
  for (const [estDate, dayEvents] of byDay) {
    if (!dayEvents.length) continue;
    dayEvents.sort((a, b) => a.start - b.start);
    const lines = dayEvents.map(
      (ev) =>
        // event_key is included in the emoji lookup as a fallback spelling ("PrizeDrop",
        // "WheelBoost", ...) for when a title doesn't match any pattern on its own.
        `${pickEmoji(`${ev.title} ${ev.eventKey}`)} **${ev.title}** \`${toEstShortDateTime(ev.start)} - ${toEstShortDateTime(ev.end)}\``
    );
    blocks.push([dayHeader(estDate), ...lines].join("\n"));
  }

  if (blocks.length) blocks[blocks.length - 1] += `\n\n${CALENDAR_URL}`;
  return blocks;
}

/**
 * Post the weekly predictions: every scheduled event on the wiki's calendar for the
 * upcoming Monday–Sunday (America/New_York), excluding milestone events and
 * tournaments, grouped by start day.
 *
 * Returns whether this week's post is settled: true when it just went out (or already
 * had), false when the calendar doesn't cover the week yet or couldn't be fetched — the
 * caller's retry cron (startWeeklyPredictionsCron in index.js) keeps trying on false.
 *
 * Dedupe is two-layered like the other jobs: db.lastPosts.weekly holds the target
 * Monday's date, and the channel scan looks for that Monday's day-header text — both
 * checked before any scraping so a settled week never opens a browser window. The
 * "found" gate requires the calendar to list events on both the target Monday and the
 * target Sunday *before* exclusions are applied, so a half-published week keeps
 * retrying instead of going out partial and then being locked in by the dedupe.
 *
 * @param {import('discord.js').Client} client - A logged-in Discord client.
 * @param {{ debug?: boolean }} [opts]
 *  - debug: post to process.env.TEST_CHANNEL_ID instead of the live channel, turn on
 *    fetch-layer debug output, and bypass both dedupe layers (never recording) so a
 *    test post always goes out.
 * @returns {Promise<boolean>}
 */
export const postWeeklyPredictions = async (client, opts = {}) => {
  const { debug = false } = opts;
  const mondayDate = getUpcomingMondayEstDate();
  const weekDates = weekDatesFrom(mondayDate);

  console.log(
    `🌀 Starting postWeeklyPredictions for week of ${mondayDate}${debug ? " (debug → test channel)" : ""}`
  );

  if (!debug) {
    const lastPosts = await getLastPosts(client);
    if (lastPosts.weekly === mondayDate) {
      console.log(`ℹ️ Weekly predictions for ${mondayDate} already recorded in db — skipping`);
      return true;
    }
    const haystack = await fetchPostedHaystack(client, [WEEKLY_CHANNEL_ID]);
    if (haystack.includes(dayHeader(mondayDate).toLowerCase())) {
      console.log(`ℹ️ Weekly predictions for ${mondayDate} already in channel — skipping`);
      return true;
    }
  }

  const html = await getMogoWikiCalendar({ debug });
  if (!html) {
    console.error("❌ Unable to retrieve HTML from Mogo Wiki events calendar");
    return false;
  }

  const all = getCalendarEvents(html, { debug });
  const weekSet = new Set(weekDates);
  const inWeek = all.filter((ev) => weekSet.has(toEstDateString(ev.start)));

  const startDays = new Set(inWeek.map((ev) => toEstDateString(ev.start)));
  if (!startDays.has(weekDates[0]) || !startDays.has(weekDates[6])) {
    console.log(
      `ℹ️ Calendar doesn't cover the full week of ${mondayDate} yet ` +
      `(${startDays.size}/7 days, ${inWeek.length} events) — will retry`
    );
    return false;
  }

  const events = inWeek.filter(
    (ev) => !EXCLUDED_TYPES.test(ev.eventKey) && !EXCLUDED_TYPES.test(ev.title)
  );
  const blocks = formatWeeklyPredictions(events, weekDates);
  if (!blocks.length) {
    console.log(`ℹ️ No predictable events left for week of ${mondayDate} after exclusions — will retry`);
    return false;
  }

  const channelId = debug ? process.env.TEST_CHANNEL_ID : WEEKLY_CHANNEL_ID;
  if (!channelId) {
    console.error("❌ Missing TEST_CHANNEL_ID for weekly predictions debug run");
    return false;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    for (const content of blocks) {
      await channel.send({ content });
    }
    console.log(`✅ Posted weekly predictions for week of ${mondayDate} (${events.length} events)`);
    if (!debug) await updateLastPosts(client, { weekly: mondayDate });
    return true;
  } catch (err) {
    console.error("💥 Failed to post weekly predictions:", err);
    return false;
  } finally {
    console.log("🏁 Finished postWeeklyPredictions\n");
  }
};

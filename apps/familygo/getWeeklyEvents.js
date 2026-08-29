import { fetchWithPlaywright } from "../../util/fetchWithPlaywright.js";
import { outputToFile } from "../../util/outputToFile.js";

const MOGO_WIKI_CALENDAR_URL = "https://monopolygo.wiki/events";

/**
 * Fetch the Monopoly GO! Wiki events calendar page (current + upcoming week) and
 * (optionally) save its rendered HTML.
 *
 * This is a different page from the news/tag indexes the daily post scrapes: it's the
 * schedule view at /events, whose day-by-day cards are what the weekly predictions
 * post is built from.
 *
 * @param {{ debug?: boolean, outPath?: string }} [opts]
 *  - debug: when true, prints extra logs and writes the HTML to a file.
 *  - outPath: custom output path (default: "./debug/monopolygo-calendar.html") used only if debug is true.
 * @returns {Promise<string|null>} Rendered HTML of the calendar page, or null on failure.
 */
export async function getMogoWikiCalendar(opts = {}) {
  const { debug = false, outPath = "./debug/monopolygo-calendar.html" } = opts;

  console.log("fetching events calendar for:", MOGO_WIKI_CALENDAR_URL);
  try {
    const html = await fetchWithPlaywright(MOGO_WIKI_CALENDAR_URL, {
      waitForSelector: "article",
    });
    console.log("[getMogoWikiCalendar] Page fetched successfully.");

    if (debug) {
      await outputToFile(outPath, html);
    }

    return html;
  } catch (err) {
    console.error("[getMogoWikiCalendar] Error fetching page:", err);
    return null;
  }
}

/**
 * Parse every scheduled event out of the calendar page's embedded data.
 *
 * The event cards are rendered from JSON records in the page's Next.js flight payload
 * (`self.__next_f.push(...)` script chunks), where each record looks like
 * `{"event_id":"08312026_SE_Plinko_Deluxe","title":"Peg-E Prize Drop",
 *   "start_date":"2026-08-31T20:00:00Z","end_date":"2026-09-02T16:59:00Z",...,
 *   "event_key":"PrizeDrop"}` — escaped inside a script string, hence the `\"` in the
 * regex. That payload is the only place the calendar exposes real end *dates*: the
 * visible cards print time-of-day ranges only, so a multi-day event's span can't be
 * recovered from the DOM.
 *
 * The `start_date`/`end_date` values are genuine UTC instants (the page itself displays
 * the raw UTC wall time, which is why its times look 4-5 hours "late" next to the
 * in-game Eastern schedule) — callers convert to America/New_York for display.
 *
 * @param {string} html - The /events calendar page HTML.
 * @param {{ debug?: boolean }} [opts]
 * @returns {Array<{ id: string, title: string, eventKey: string, imageUrl: string|null, start: Date, end: Date }>}
 *   Deduped by event id, sorted by start time.
 */
export function getCalendarEvents(html, opts = {}) {
  const { debug = false } = opts;
  if (!html) return [];

  // Each record starts with event_id and ends with event_key (fixed field order in the
  // flight payload). Non-greedy so one match can't swallow its neighbor.
  const recordRe = /\{\\"event_id\\":.*?\\"event_key\\":\\"[^"]*?\\"\}/g;
  const matches = html.match(recordRe) || [];

  const byId = new Map();
  for (const m of matches) {
    let record;
    try {
      // First parse unescapes the script-string escaping, second parses the JSON itself.
      record = JSON.parse(JSON.parse('"' + m + '"'));
    } catch (e) {
      if (debug) console.warn("[getCalendarEvents] Skipping unparseable record:", e?.message, m.slice(0, 80));
      continue;
    }

    const { event_id: id, title, event_key: eventKey, image_url: imageUrl, start_date, end_date } = record;
    const start = new Date(start_date);
    const end = new Date(end_date);
    if (!id || !title || title === "$undefined" || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      if (debug) console.warn("[getCalendarEvents] Skipping incomplete record:", id, title);
      continue;
    }
    if (byId.has(id)) continue; // same event appears in "Current events" and its day section

    byId.set(id, {
      id,
      title: title.trim(),
      eventKey: typeof eventKey === "string" && eventKey !== "$undefined" ? eventKey : "",
      imageUrl: typeof imageUrl === "string" && imageUrl !== "$undefined" ? imageUrl : null,
      start,
      end,
    });
  }

  const events = [...byId.values()].sort((a, b) => a.start - b.start);

  if (debug) {
    console.log(`[getCalendarEvents] matched=${matches.length} unique=${events.length}`);
  }

  return events;
}

import * as cheerio from "cheerio";

/**
 * Schedule scraper for the "streams" cron (jobs/streams.js): reads a
 * methstreams league page (https://methstreams.gs/league/nbastreams) into a
 * flat list of games with their ET start times and stream-page links.
 *
 * Nothing here touches Discord — like weather.js and news.js it is a pure
 * fetch/parse layer.
 *
 * The page is server-rendered: a `<h2>Monday, October 5, 2026</h2>` per day,
 * each followed by `<a class="card" href="/stream/<slug>">` cards carrying the
 * matchup and a "Start time: 7:00 PM ET" line. Every league page on the site
 * shares that template, so `source` can point at /league/nflstreams just as
 * well.
 *
 * Plain HTTPS first, Playwright only as a fallback. The site sits behind
 * Cloudflare but, from a residential connection, answers a bare `fetch` with
 * the real page whatever the User-Agent — the Cloudflare script it carries is
 * the passive beacon, not a challenge. A datacenter IP (the Heroku dyno) is
 * what Cloudflare is likelier to challenge, so a response that isn't the
 * schedule page gets one retry through a real browser before giving up.
 */

export const DEFAULT_SOURCE = "https://methstreams.gs/league/nbastreams";

const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const pad = (n) => String(n).padStart(2, "0");

/** "Monday, October 5, 2026" → "2026-10-05", or null when the heading isn't a date. */
export function parseDayHeading(text) {
  const match = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(String(text));
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${pad(month)}-${pad(Number(match[2]))}`;
}

/** "Start time: 7:00 PM ET" → "19:00", or null for "TBD" and the like. */
export function parseStartTime(text) {
  const match = /(\d{1,2}):(\d{2})\s*([AP])\.?M/i.exec(String(text));
  if (!match) return null;
  const hour12 = Number(match[1]);
  if (hour12 < 1 || hour12 > 12) return null;
  const hour = (hour12 % 12) + (match[3].toUpperCase() === "P" ? 12 : 0);
  return `${pad(hour)}:${match[2]}`;
}

/** "19:00" → "7:00 PM" — how the site itself prints it. */
export function formatStartTime(time) {
  const [hour, minute] = String(time).split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return String(time ?? "");
  return `${hour % 12 || 12}:${pad(minute)} ${hour < 12 ? "AM" : "PM"}`;
}

/** Does this HTML look like a league schedule page rather than a challenge or error page? */
const isSchedulePage = ($) => $(".main h1").length > 0;

/**
 * Every game on a league page, in page order:
 * `[{ key, slug, title, date: "YYYY-MM-DD", time: "HH:mm" | null, url }]`.
 *
 * `key` is date + slug — the site reuses a matchup's slug for a rematch, so
 * the slug alone isn't unique across days. A card whose start time won't parse
 * keeps `time: null` (stored, but never scheduled) rather than being dropped,
 * so a "TBD" that firms up on the next fetch just gains a time.
 *
 * Throws when the HTML isn't a schedule page at all — an empty list has to
 * mean "no games", never "couldn't read it".
 */
export function parseSchedule(html, baseUrl = DEFAULT_SOURCE) {
  const $ = cheerio.load(html);
  if (!isSchedulePage($)) throw new Error("Response isn't a schedule page (blocked or changed layout?).");

  const games = [];
  let date = null;
  // cheerio returns a multi-selector match in document order, which is what
  // lets each card inherit the last day heading above it.
  $(".main").find("h2, a.card").each((_, el) => {
    const node = $(el);
    if (el.tagName === "h2") {
      date = parseDayHeading(node.text()) ?? date;
      return;
    }
    const href = node.attr("href");
    const title = node.find(".card-title").text().replace(/\s+/g, " ").trim();
    if (!date || !href || !title) return;

    const url = new URL(href, baseUrl).href;
    const slug = new URL(url).pathname.split("/").filter(Boolean).pop() ?? title;
    games.push({
      key: `${date}/${slug}`,
      slug,
      title,
      date,
      time: parseStartTime(node.find(".card-subtitle").text()),
      url,
    });
  });
  return games;
}

async function fetchPlain(url) {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Fetch and parse a league page. Plain HTTPS first; any failure there — an
 * HTTP error, a timeout, or a page that isn't the schedule — gets a second
 * attempt through Playwright. Only both failing throws.
 *
 * Playwright is imported lazily: it is the rare path, and this module lives in
 * the nukoko dyno's process, which has no other use for a browser driver.
 */
export async function getSchedule(source = DEFAULT_SOURCE) {
  const url = String(source || DEFAULT_SOURCE).trim();
  try {
    return parseSchedule(await fetchPlain(url), url);
  } catch (plainErr) {
    console.warn(`⚠️ [chappelly] Plain fetch of ${url} failed (${plainErr.message}) — retrying with Playwright.`);
    try {
      const { fetchWithPlaywright } = await import("../../util/fetchWithPlaywright.js");
      return parseSchedule(await fetchWithPlaywright(url, { waitForSelector: ".main h1" }), url);
    } catch (browserErr) {
      throw new Error(`Couldn't read ${url}: ${plainErr.message}; Playwright: ${browserErr.message}`);
    }
  }
}

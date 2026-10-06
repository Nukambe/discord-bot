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
 * The site sits behind Cloudflare. From a residential connection a bare
 * `fetch` gets the real page whatever the User-Agent, but from the Heroku dyno
 * it answers 403 — and headless Chrome gets the challenge page too, which is
 * why there is no Playwright step here (headed Chrome, the thing that passes
 * for familygo, needs a display a dyno doesn't have).
 *
 * So when methstreams won't answer, the schedule comes from **ESPN's public
 * scoreboard API** instead: no key, not behind Cloudflare, and its start times
 * match the site's. What it can't give is the methstreams game link — the
 * site's slugs aren't derivable from the matchup (usually away-vs-home, but
 * "milwaukee-bucks-vs-minnesota-timberwolves" is home first, and the reverse
 * 404s), and the dyno can't check a guess. ESPN-sourced games therefore link to
 * the league schedule page, marked `direct: false`, rather than to a guessed
 * page that might not exist.
 */

export const DEFAULT_SOURCE = "https://methstreams.gs/league/nbastreams";

const REQUEST_TIMEOUT_MS = 20_000;
const TIMEZONE = "America/New_York";

/**
 * methstreams league page → ESPN scoreboard path, for the fallback. A league
 * missing here (CFB's hundreds of games a week, MMA, F1) simply has none.
 */
const ESPN_LEAGUES = {
  nbastreams: "basketball/nba",
  wnbastreams: "basketball/wnba",
  nflstreams: "football/nfl",
  nhlstreams: "hockey/nhl",
  mlbstreams: "baseball/mlb",
};
const ESPN_SKIP_STATUSES = new Set(["STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_SUSPENDED"]);
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

// ---------------------------------------------------------------------------
// ESPN fallback
// ---------------------------------------------------------------------------

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** An instant as its ET `{ date: "YYYY-MM-DD", time: "HH:mm" }`. */
function toEt(instant) {
  const p = {};
  for (const part of ET_PARTS.formatToParts(instant)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const espnLeagueFor = (source) => {
  try {
    return ESPN_LEAGUES[new URL(source).pathname.split("/").filter(Boolean).pop()] ?? null;
  } catch {
    return null;
  }
};

/**
 * One ESPN scoreboard day as games. ESPN's `dates` is an ET day (a 10pm ET tip
 * is listed under that day even though it is past midnight UTC), takes no
 * ranges, and answers 400 to one — hence a call per day.
 */
async function espnDay(league, date, source) {
  const res = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/${league}/scoreboard?dates=${date.replaceAll("-", "")}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const { events = [] } = await res.json();

  return events
    .filter((event) => !ESPN_SKIP_STATUSES.has(event?.status?.type?.name))
    .map((event) => {
      const competition = event.competitions?.[0] ?? {};
      const side = (homeAway) => competition.competitors?.find((c) => c.homeAway === homeAway)?.team?.displayName;
      const [away, home] = [side("away"), side("home")];
      const title = away && home ? `${away} vs ${home}` : String(event.name ?? "").replace(" at ", " vs ");
      const { date: etDate, time } = toEt(new Date(event.date));
      const slug = slugify(title);
      return {
        key: `${etDate}/${slug}`,
        slug,
        title,
        date: etDate,
        // ESPN parks an unannounced tip at a placeholder time and says so here.
        time: competition.timeValid === false ? null : time,
        url: source,
        direct: false,
      };
    });
}

/** Today's and tomorrow's games from ESPN, or throws when the league has no mapping. */
async function espnSchedule(source) {
  const league = espnLeagueFor(source);
  if (!league) throw new Error("no ESPN fallback for this league");
  const today = toEt(new Date()).date;
  const tomorrow = toEt(new Date(Date.now() + 24 * 60 * 60 * 1000)).date;
  const days = await Promise.all([today, tomorrow].map((date) => espnDay(league, date, source)));
  return days.flat().sort((a, b) => `${a.date} ${a.time ?? "99"}`.localeCompare(`${b.date} ${b.time ?? "99"}`));
}

/**
 * Today's games and on, as `{ games, via }`. methstreams first, for its direct
 * game links; when it won't answer (403 from the dyno), ESPN for the schedule
 * with the league page as every game's link. Only both failing throws.
 */
export async function getSchedule(source = DEFAULT_SOURCE) {
  const url = String(source || DEFAULT_SOURCE).trim();
  try {
    return { games: parseSchedule(await fetchPlain(url), url), via: "methstreams" };
  } catch (siteErr) {
    console.warn(`⚠️ [chappelly] Couldn't read ${url} (${siteErr.message}) — falling back to ESPN's schedule.`);
    try {
      return { games: await espnSchedule(url), via: "ESPN" };
    } catch (espnErr) {
      // Angle brackets keep Discord from unfurling the URL when /cron run
      // echoes this back.
      throw new Error(`Couldn't read <${url}>: ${siteErr.message}; ESPN fallback: ${espnErr.message}`);
    }
  }
}

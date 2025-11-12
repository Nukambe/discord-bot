import * as cheerio from "cheerio";
import { fetchWithPlaywright } from "../../util/fetchWithPlaywright.js";
import { outputToFile } from "../../util/outputToFile.js";

const MOGO_WIKI_EVENTS_URL = "https://monopolygo.wiki/tag/events/";

/**
 * Fetch the Monopoly GO! Wiki "Events" index page and (optionally) save its rendered HTML.
 *
 * @param {{ debug?: boolean, outPath?: string }} [opts]
 *  - debug: when true, prints extra logs and writes the HTML to a file.
 *  - outPath: custom output path (default: "./monopolygo-events.html") used only if debug is true.
 * @returns {Promise<string|null>} Rendered HTML of the events index page, or null on failure.
 */
export async function getMogoWikiEvents(opts = {}) {
  const { debug = false, outPath = "./monopolygo-events.html" } = opts;

  console.log("fetching events for:", MOGO_WIKI_EVENTS_URL);
  try {
    const html = await fetchWithPlaywright(MOGO_WIKI_EVENTS_URL);
    console.log("[getMogoWikiEvents] Page fetched successfully.");

    if (debug) {
      await outputToFile(outPath, html);
    }

    return html;
  } catch (err) {
    console.error("[getMogoWikiEvents] Error fetching page:", err);
    return null;
  }
}

/**
 * Find the Monopoly GO event URL for a given date by scanning <a.gh-card-link> elements.
 *
 * Assumes each event card on the index uses an anchor with class "gh-card-link".
 * Builds and returns an absolute URL using the provided base.
 *
 * @param {string} html - The Monopoly GO Events page HTML.
 * @param {string} dateSlug - e.g. "nov-11-2025"
 * @param {string} [base="https://monopolygo.wiki"] - Base for resolving relative links.
 * @param {{ debug?: boolean }} [opts]
 *  - debug: when true, prints extra logs (prefix and inspected hrefs).
 * @returns {string|null} The absolute event URL, or null if not found.
 */
export function getEventUrlFromHtml(html, dateSlug, opts = {}) {
  const { debug = false } = opts;
  const base = "https://monopolygo.wiki";

  if (!html || !dateSlug) return null;

  const $ = cheerio.load(html);
  const prefix = `/todays-events-${dateSlug}`;

  if (debug) {
    console.log("Event Prefix:", prefix);
  }

  const anchors = $("a.gh-card-link");
  for (const el of anchors) {
    const href = $(el).attr("href")?.trim();

    if (debug) {
      console.log("Checking href:", href);
      console.log("href match?:", href?.startsWith(prefix));
    }

    if (href?.startsWith(prefix)) {
      try {
        return new URL(href, base).toString();
      } catch (e) {
        if (debug) console.error("[getEventUrlFromHtml] URL construction failed:", e?.message);
        return null;
      }
    }
  }

  return null;
}

/**
 * Fetch a specific Monopoly GO event page (given its absolute URL) and (optionally) save its HTML.
 *
 * @param {string} eventUrl - Full Monopoly GO event URL
 *   (e.g. "https://monopolygo.wiki/todays-events-nov-11-2025-battleship/").
 * @param {{ debug?: boolean, outPath?: string }} [opts]
 *  - debug: when true, prints extra logs and writes the HTML to a file.
 *  - outPath: custom output path (default: "./monopolygo-event.html") used only if debug is true.
 * @returns {Promise<string|null>} Rendered HTML of the event page, or null on failure.
 */
export async function getMogoEventPage(eventUrl, opts = {}) {
  const { debug = false, outPath = "./monopolygo-event.html" } = opts;

  if (!eventUrl) {
    console.error("[getMogoEventPage] Missing event URL.");
    return null;
  }

  if (debug) {
    console.log("[getMogoEventPage] Fetching:", eventUrl);
  }

  try {
    const html = await fetchWithPlaywright(eventUrl);
    console.log("[getMogoEventPage] Page fetched successfully.");

    if (debug) {
      await outputToFile(outPath, html);
    }

    return html;
  } catch (err) {
    console.error("[getMogoEventPage] Error fetching page:", err);
    return null;
  }
}

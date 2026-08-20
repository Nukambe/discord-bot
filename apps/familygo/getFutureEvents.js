import * as cheerio from "cheerio";
import { fetchWithPlaywright } from "../../util/fetchWithPlaywright.js";
import { outputToFile } from "../../util/outputToFile.js";
import { toEstDateString } from "../../util/dateUtils.js";

const MOGO_WIKI_NEWS_URL = "https://monopolygo.wiki/news";
const BASE_URL = "https://monopolygo.wiki";

/**
 * Fetch the Monopoly GO! Wiki "News" index page and (optionally) save its rendered HTML.
 *
 * @param {{ debug?: boolean, outPath?: string }} [opts]
 * @returns {Promise<string|null>} Rendered HTML of the news index page, or null on failure.
 */
export async function getMogoWikiNews(opts = {}) {
  const { debug = false, outPath = "./debug/monopolygo-news.html" } = opts;

  console.log("fetching news for:", MOGO_WIKI_NEWS_URL);
  try {
    const html = await fetchWithPlaywright(MOGO_WIKI_NEWS_URL, {
      waitForSelector: "h2 a[href]",
    });
    console.log("[getMogoWikiNews] Page fetched successfully.");

    if (debug) {
      await outputToFile(outPath, html);
    }

    return html;
  } catch (err) {
    console.error("[getMogoWikiNews] Error fetching page:", err);
    return null;
  }
}

/**
 * Parse the news index HTML into post cards published on `targetEstDates`
 * (America/New_York, "YYYY-MM-DD"), excluding "Today's Events" daily posts and the
 * "Free Dice Links Today" post — both are handled by the separate daily-post flow
 * (see postEventToDiscord / postNewFreeDiceLinks in index.js).
 *
 * Each card is a `<h2><a href="...">Title</a></h2>` with a sibling `<time datetime="...">`.
 *
 * Takes several dates because the caller scans a rolling window on a repeating cron; the
 * `<time datetime>` values are UTC and the wiki habitually publishes late in the Eastern
 * evening, so a post's EST publish date is regularly the day before the run that first
 * sees it. See postFutureEventsToDiscord for why the window is wider than one day.
 *
 * @param {string} html - The Monopoly GO News page HTML.
 * @param {string|string[]} targetEstDates - e.g. "2026-08-01" or ["2026-08-01", "2026-07-31"]
 * @param {{ debug?: boolean }} [opts]
 * @returns {Array<{ url: string, title: string, publishDate: Date }>}
 */
export function getFutureEventPosts(html, targetEstDates, opts = {}) {
  const { debug = false } = opts;
  if (!html || !targetEstDates) return [];

  const wanted = new Set(Array.isArray(targetEstDates) ? targetEstDates : [targetEstDates]);
  if (!wanted.size) return [];

  const $ = cheerio.load(html);
  const posts = [];

  $("h2 a[href]").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href")?.trim();
    if (!href || href.startsWith("/todays-events-") || href === "/latest-reward-links") return;

    const timeEl = $a.closest("h2").parent().find("time").first();
    const datetime = timeEl.attr("datetime");
    if (!datetime) return;

    const publishDate = new Date(datetime);
    if (Number.isNaN(publishDate.getTime())) return;

    if (!wanted.has(toEstDateString(publishDate))) return;

    let url;
    try {
      url = new URL(href, BASE_URL).toString();
    } catch (e) {
      if (debug) console.error("[getFutureEventPosts] URL construction failed:", e?.message);
      return;
    }

    posts.push({ url, title: $a.text().replace(/\s+/g, " ").trim(), publishDate });
  });

  if (debug) {
    console.log(
      `[getFutureEventPosts] target=${[...wanted].join(",")} found=${posts.length}:`,
      posts.map((p) => p.url)
    );
  }

  return posts;
}

import * as cheerio from "cheerio";
import { fetchWithPlaywright } from "../../util/fetchWithPlaywright.js";
import { outputToFile } from "../../util/outputToFile.js";

const MOGO_WIKI_NEWS_URL = "https://monopolygo.wiki/news";
const BASE_URL = "https://monopolygo.wiki";

/**
 * Fetch the Monopoly GO! Wiki "News" index page and (optionally) save its rendered HTML.
 *
 * @param {{ debug?: boolean, outPath?: string }} [opts]
 * @returns {Promise<string|null>} Rendered HTML of the news index page, or null on failure.
 */
export async function getMogoWikiNews(opts = {}) {
  const { debug = false, outPath = "./monopolygo-news.html" } = opts;

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
 * Parse the news index HTML into post cards published on `targetEstDate`
 * (America/New_York, "YYYY-MM-DD"), excluding "Today's Events" daily posts —
 * those are handled by the separate daily-events cron/command.
 *
 * Each card is a `<h2><a href="...">Title</a></h2>` with a sibling `<time datetime="...">`.
 *
 * @param {string} html - The Monopoly GO News page HTML.
 * @param {string} targetEstDate - e.g. "2026-08-01"
 * @param {{ debug?: boolean }} [opts]
 * @returns {Array<{ url: string, title: string, publishDate: Date }>}
 */
export function getFutureEventPosts(html, targetEstDate, opts = {}) {
  const { debug = false } = opts;
  if (!html || !targetEstDate) return [];

  const $ = cheerio.load(html);
  const posts = [];

  $("h2 a[href]").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href")?.trim();
    if (!href || href.startsWith("/todays-events-")) return;

    const timeEl = $a.closest("h2").parent().find("time").first();
    const datetime = timeEl.attr("datetime");
    if (!datetime) return;

    const publishDate = new Date(datetime);
    if (Number.isNaN(publishDate.getTime())) return;

    const estDate = publishDate.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (estDate !== targetEstDate) return;

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
      `[getFutureEventPosts] target=${targetEstDate} found=${posts.length}:`,
      posts.map((p) => p.url)
    );
  }

  return posts;
}

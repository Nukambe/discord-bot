import * as cheerio from "cheerio";
import { fetchWithPlaywright } from "../../util/fetchWithPlaywright.js";
import { outputToFile } from "../../util/outputToFile.js";
import { urlKey } from "./alreadyPosted.js";

const MOGO_WIKI_NEWS_URL = "https://monopolygo.wiki/news";
const BASE_URL = "https://monopolygo.wiki";

// Posts whose title names the wiki itself are site announcements, not events.
const SITE_ANNOUNCEMENT_TITLE_RE = /mogo\s*wiki/i;

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
 * @typedef {object} NewsCard
 * @property {string} url - Absolute article URL, from the card's own href (see parseFutureEventPost
 *   for why the href, not the article's metadata, is the identity of a post).
 * @property {string} title
 * @property {Date} publishDate - The card's `<time datetime>` (UTC).
 * @property {"todays-events"|"free-dice"|"site"|"article"} kind - What the card is: the
 *   daily "Today's Events" post (handled by the daily-post job), the "Free Dice Links Today"
 *   post (postNewFreeDiceLinks), a post about the wiki itself, or an article worth posting.
 */

/**
 * Classify a news card by its path and title.
 * @param {string} pathname
 * @param {string} title
 * @returns {NewsCard["kind"]}
 */
export function classifyNewsCard(pathname, title) {
  if (pathname.startsWith("/todays-events-")) return "todays-events";
  if (pathname === "/latest-reward-links") return "free-dice";
  if (SITE_ANNOUNCEMENT_TITLE_RE.test(title)) return "site";
  return "article";
}

/**
 * Parse every card on the news index into NewsCards, newest first.
 *
 * Each card is a `<h2><a href="...">Title</a></h2>` with a sibling `<time datetime="...">`;
 * cards without a parseable time are dropped, since ordering is the whole point. Nothing is
 * filtered here — the "Today's Events" cards are what the caller uses as day markers
 * (see selectPostsSinceMarker), so they have to come through with everything else.
 *
 * @param {string} html - The Monopoly GO News page HTML.
 * @param {{ debug?: boolean }} [opts]
 * @returns {NewsCard[]}
 */
export function getNewsIndexPosts(html, opts = {}) {
  const { debug = false } = opts;
  if (!html) return [];

  const $ = cheerio.load(html);
  const cards = [];
  const seen = new Set();

  $("h2 a[href]").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href")?.trim();
    if (!href) return;

    const timeEl = $a.closest("h2").parent().find("time").first();
    const datetime = timeEl.attr("datetime");
    if (!datetime) return;

    const publishDate = new Date(datetime);
    if (Number.isNaN(publishDate.getTime())) return;

    let parsed;
    try {
      parsed = new URL(href, BASE_URL);
    } catch (e) {
      if (debug) console.error("[getNewsIndexPosts] URL construction failed:", e?.message);
      return;
    }

    const url = parsed.toString();
    const key = urlKey(url);
    if (seen.has(key)) return;
    seen.add(key);

    const title = $a.text().replace(/\s+/g, " ").trim();
    cards.push({ url, title, publishDate, kind: classifyNewsCard(parsed.pathname, title) });
  });

  cards.sort((a, b) => b.publishDate - a.publishDate);

  if (debug) {
    console.log(`[getNewsIndexPosts] ${cards.length} card(s):`);
    for (const c of cards) console.log(`  ${c.publishDate.toISOString()} [${c.kind}] ${c.url}`);
  }

  return cards;
}

/**
 * The identity of a post for the sweep's "already searched" list: its URL plus the publish
 * time the index showed for it. The wiki republishes articles in place with a new date
 * (and sometimes at a new `-2` URL), and a republished post should be looked at again.
 * @param {NewsCard} card
 * @returns {{ key: string, at: string }}
 */
export function searchedEntry(card) {
  return { key: urlKey(card.url), at: card.publishDate.toISOString() };
}

/**
 * Pick the news cards the sweep should look at this run.
 *
 * The wiki's "Today's Events (<date>)" posts are used as the day markers instead of the
 * cards' own dates: they land on the index at irregular hours (anywhere from the previous
 * morning to the previous night), so "published yesterday" never cleanly described one
 * day's worth of articles. The rule is: everything newer than the marker the previous
 * run stopped at (`state.cutoff`), minus what that run already searched. With no stored
 * cutoff (first run), the marker before the newest one is used so the seed window covers
 * a full day; the caller's channel scan makes any overlap harmless.
 *
 * The newest marker becomes the next run's cutoff (the caller decides when to advance it).
 * Nothing caps the top of the window: if the next "Today's Events" is already up, posts
 * after it are simply new too.
 *
 * @param {NewsCard[]} cards - From getNewsIndexPosts (newest first).
 * @param {{ cutoff?: string|null, searched?: Array<{ key: string, at: string }> }} state
 * @param {{ ignoreSearched?: boolean }} [opts] - ignoreSearched: consider posts the previous
 *   run already looked at (debug runs, so a test always has something to post).
 * @returns {{ candidates: NewsCard[], skipped: NewsCard[], latestMarker: NewsCard|null, lowerBound: Date|null }}
 *   candidates: article cards newer than the bound and not yet searched; skipped: article
 *   cards newer than the bound that were searched already (still "handled" for the state).
 */
export function selectPostsSinceMarker(cards, state = {}, opts = {}) {
  const { ignoreSearched = false } = opts;
  const markers = cards.filter((c) => c.kind === "todays-events");
  const latestMarker = markers[0] ?? null;

  let lowerBound = null;
  if (state.cutoff) {
    const stored = new Date(state.cutoff);
    if (!Number.isNaN(stored.getTime())) lowerBound = stored;
  }
  if (!lowerBound) {
    const seed = markers[1] ?? markers[0] ?? null;
    lowerBound = seed ? seed.publishDate : null;
  }
  if (!lowerBound) return { candidates: [], skipped: [], latestMarker, lowerBound: null };

  const searched = new Set((state.searched ?? []).map((s) => `${s.key}@${s.at}`));
  const candidates = [];
  const skipped = [];
  for (const card of cards) {
    if (card.kind !== "article" || card.publishDate <= lowerBound) continue;
    const { key, at } = searchedEntry(card);
    if (!ignoreSearched && searched.has(`${key}@${at}`)) skipped.push(card);
    else candidates.push(card);
  }

  return { candidates, skipped, latestMarker, lowerBound };
}

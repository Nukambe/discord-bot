import * as cheerio from "cheerio";

/**
 * RSS/Atom client for the news cron (jobs/news.js).
 *
 * Plain syndication feeds are the provider for the same reason Open-Meteo is
 * the weather one (see weather.js): they need no API key. Every keyed news API
 * — NewsAPI, GNews, NewsData — would put a secret back in .env and mean a
 * redeploy to rotate it, in a bot whose whole point is being configurable from
 * Discord. Feeds cost nothing, need no account, and are just XML over HTTPS.
 *
 * Nothing here touches Discord; it's a pure fetch/parse layer turning a list of
 * feeds into a flat, deduped, newest-last list of articles.
 *
 * Deliberately *not* Google News RSS, which is otherwise the best local source:
 * its article links stay on news.google.com and only unwrap in JavaScript
 * (curl -L ends on the google URL with a 200), so posts would carry an opaque
 * redirect Discord can't unfurl and the channel scan can't compare.
 */

const REQUEST_TIMEOUT_MS = 15_000;
// Both NPR and Patch serve a plain bot UA; nothing here needs to look like a
// browser, unlike familygo's Cloudflare-fronted wiki.
const USER_AGENT = "chappelly-bot/1.0 (+https://github.com/Nukambe/discord-bot)";

/**
 * Feeds a cron can name instead of spelling out a URL, so `feeds` in the env
 * reads as ["npr", "patch-belair"]. A raw https URL works too and takes its
 * label from the feed's own <title>.
 *
 * Every one of these was checked live before being listed. Some obvious
 * candidates are missing on purpose: AP killed its public RSS, the Baltimore
 * Sun's feed 403s bots, and foxbaltimore.com/feed 404s.
 */
export const FEED_PRESETS = {
  npr: { label: "NPR", url: "https://feeds.npr.org/1001/rss.xml", color: 0xe2231a },
  "patch-belair": { label: "Patch · Bel Air", url: "https://patch.com/feeds/maryland/belair", color: 0x00a3a1 },
  bbc: { label: "BBC News", url: "https://feeds.bbci.co.uk/news/rss.xml", color: 0xbb1919 },
  guardian: { label: "The Guardian", url: "https://www.theguardian.com/us-news/rss", color: 0x052962 },
  "baltimore-banner": {
    label: "The Baltimore Banner",
    url: "https://www.thebaltimorebanner.com/arc/outboundfeeds/rss/",
    color: 0x1b3a6b,
  },
  wbal: { label: "WBAL-TV 11", url: "https://www.wbaltv.com/topstories-rss", color: 0x0a4595 },
  wjz: { label: "WJZ · CBS Baltimore", url: "https://www.cbsnews.com/baltimore/latest/rss/local", color: 0x0033a0 },
};

/** Fallback embed colour for a feed given as a bare URL. */
const DEFAULT_COLOR = 0x5865f2;

/**
 * A feeds entry → `{ key, label, url, color }`. Accepts a preset key, a raw
 * URL, or an object overriding any of the three — so a feed can be added from
 * Discord with /env without touching this file.
 */
export function resolveFeed(entry) {
  if (entry && typeof entry === "object") {
    const preset = FEED_PRESETS[entry.preset] ?? {};
    const url = String(entry.url || preset.url || "").trim();
    if (!url) throw new Error(`Feed entry ${JSON.stringify(entry)} has no url.`);
    return { key: entry.preset || url, label: entry.label || preset.label || "", url, color: entry.color ?? preset.color ?? DEFAULT_COLOR };
  }

  const token = String(entry ?? "").trim();
  if (!token) throw new Error("Empty feed entry.");
  if (FEED_PRESETS[token]) return { key: token, ...FEED_PRESETS[token] };
  if (/^https?:\/\//i.test(token)) return { key: token, label: "", url: token, color: DEFAULT_COLOR };
  throw new Error(`Unknown feed "${token}" — use a URL or one of: ${Object.keys(FEED_PRESETS).join(", ")}.`);
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/**
 * The link as posted: https, no query string, no fragment.
 *
 * The query string has to go before posting, not just before comparing. Patch
 * appends a different utm_* block to every link it hands out (`?utm_source=
 * article-mostrecent&utm_campaign=recirc&...`), so the raw href is not stable
 * enough to ask "did we already post this?" — the same story would look new
 * every run. Stripping it up front means the channel scan is comparing the
 * same string a previous post is carrying.
 *
 * Nothing else about the URL is touched, so what goes out is still a link the
 * publisher serves.
 */
export function cleanUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const url = new URL(s);
    url.protocol = "https:";
    url.hash = "";
    url.search = "";
    let out = url.toString();
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return s;
  }
}

/**
 * An article's identity for comparison only — `cleanUrl` with the host
 * lower-cased and a leading `www.` dropped, so npr.org and www.npr.org are one
 * article. Kept separate from cleanUrl because a host that *needs* its www
 * would 404 if the posted link were normalized this far.
 */
export function urlKey(raw) {
  const cleaned = cleanUrl(raw);
  try {
    const url = new URL(cleaned);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    let out = url.toString();
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return cleaned;
  }
}

/** Patch files each story under a section it passes as `utm_term`. */
function sectionOf(rawLink) {
  try {
    const term = new URL(rawLink).searchParams.get("utm_term");
    if (!term) return "";
    return term.replace(/\s+/g, " ").trim().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const text = ($el) => $el.first().text().replace(/\s+/g, " ").trim();

/** Strip the markup out of an HTML summary and collapse it to one line. */
const plain = (html) =>
  cheerio.load(`<div>${html ?? ""}</div>`)("div").text().replace(/\s+/g, " ").trim();

// NPR ends every content:encoded with a 1x1 analytics beacon; taking the first
// <img> would otherwise be right and taking the last would always be wrong.
const TRACKING_IMAGE = /(rss-pixel|\/tracking\/|1x1\.(gif|png))/i;

/**
 * An article's artwork. Feeds disagree about where it lives: Patch uses
 * <media:thumbnail>, NPR embeds it as the first <img> of <content:encoded>,
 * and plenty of others use <enclosure> or <media:content>.
 */
function imageOf($, item) {
  const attr = (selector, name = "url") => {
    const value = $(item).find(selector).first().attr(name);
    return typeof value === "string" && /^https?:\/\//i.test(value) ? value : "";
  };

  const direct =
    attr("media\\:thumbnail") ||
    attr("media\\:content") ||
    attr("enclosure") ||
    attr("image", "href");
  if (direct) return direct;

  const body = $(item).find("content\\:encoded").first().text() || $(item).find("description").first().text();
  if (!body.includes("<img")) return "";
  const $body = cheerio.load(`<div>${body}</div>`);
  const src = $body("img")
    .toArray()
    .map((el) => $body(el).attr("src") ?? "")
    .find((url) => /^https?:\/\//i.test(url) && !TRACKING_IMAGE.test(url));
  return src ?? "";
}

/** An <item> (RSS) or <entry> (Atom) → a normalized article, or null if unusable. */
function parseItem($, el, feed) {
  const item = $(el);

  // Atom puts the URL on <link href>, RSS in the element's text. Reddit and a
  // few others are Atom-only, so both shapes are read rather than assumed.
  const rawLink = text(item.find("link")) || item.find("link").first().attr("href") || text(item.find("guid"));
  const url = cleanUrl(rawLink);
  const title = text(item.find("title"));
  if (!url || !title) return null;

  const rawDate =
    text(item.find("pubDate")) ||
    text(item.find("published")) ||
    text(item.find("updated")) ||
    text(item.find("dc\\:date"));
  const published = rawDate ? new Date(rawDate) : null;

  const summary = plain(text(item.find("description")) || text(item.find("summary")));

  return {
    id: urlKey(rawLink),
    url,
    title,
    summary,
    image: imageOf($, el),
    author: text(item.find("dc\\:creator")) || text(item.find("author > name")),
    section: sectionOf(rawLink),
    published: published && !Number.isNaN(published.valueOf()) ? published : null,
    feed,
  };
}

/** Parse a feed document into `{ label, items }`. */
export function parseFeed(xml, feed) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const label = feed.label || text($("channel > title")) || text($("feed > title")) || feed.url;
  const resolved = { ...feed, label };
  const items = $("item, entry")
    .toArray()
    .map((el) => parseItem($, el, resolved))
    .filter(Boolean);
  return { ...resolved, items };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Fetch and parse one feed. @returns {Promise<{ label, items }>} */
export async function fetchFeed(feed) {
  return parseFeed(await fetchText(feed.url), feed);
}

/**
 * Every article across `entries`, oldest first.
 *
 * A feed that fails is reported in `failures` rather than thrown: one dead
 * feed must not cost the caller the feeds that did load, and the next hourly
 * slot will try it again anyway. `maxAgeHours` is the real safety net against
 * a feed republishing its whole backlog — combined with the channel scan in
 * jobs/news.js, an article has to be both unseen *and* recent to go out.
 *
 * @returns {Promise<{ items: object[], failures: Array<{ feed: object, error: string }> }>}
 */
export async function getNews(entries, { maxAgeHours = 48, maxPerFeed = 10 } = {}) {
  const feeds = (Array.isArray(entries) ? entries : []).map(resolveFeed);
  const cutoff = Date.now() - maxAgeHours * 3_600_000;

  const settled = await Promise.all(
    feeds.map((feed) => fetchFeed(feed).then((parsed) => ({ parsed }), (error) => ({ feed, error }))),
  );

  const failures = [];
  const seen = new Set();
  const items = [];

  for (const result of settled) {
    if (result.error) {
      failures.push({ feed: result.feed, error: result.error.message ?? String(result.error) });
      continue;
    }
    const fresh = result.parsed.items
      // An undated item is kept: a feed that omits pubDate would otherwise go
      // permanently silent, and the channel scan still stops repeats.
      .filter((item) => !item.published || item.published.valueOf() >= cutoff)
      .sort((a, b) => (b.published?.valueOf() ?? 0) - (a.published?.valueOf() ?? 0))
      // Capped per feed, not overall, so one chatty feed can't crowd the other
      // out of a single run. The remainder isn't lost — it's still unposted and
      // still inside maxAgeHours, so the next slot picks it up.
      .slice(0, maxPerFeed);
    for (const item of fresh) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  // Oldest first, so a run posting several articles reads down the channel in
  // the order the day actually happened.
  items.sort((a, b) => (a.published?.valueOf() ?? 0) - (b.published?.valueOf() ?? 0));
  return { items, failures };
}

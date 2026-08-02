import * as cheerio from "cheerio";

/**
 * Parse a Monopoly GO Wiki article page into the fields needed for a Discord post:
 * title, canonical URL, publish date, hero image, in-article "editorial" images, and
 * category tags.
 *
 * Title/url/publishDate/hero image come from the page's Article/BlogPosting JSON-LD
 * block, which the site already publishes for SEO — more reliable than scraping the
 * visual layout, which varies per post type (plain article vs. custom event blocks).
 * Some post types (e.g. album previews) omit that JSON-LD, so each field falls back
 * to a DOM-scraped equivalent.
 *
 * @param {string} html - Raw HTML of the article page.
 * @param {{ sourceUrl?: string }} [opts]
 * @returns {{ title: string, url: string|null, publishDate: Date|null, heroImage: string|null, editorialImages: string[], tags: string[] }}
 */
export function parseFutureEventPost(html, opts = {}) {
  const { sourceUrl } = opts;
  const $ = cheerio.load(html);

  const article = readArticleLd($);

  const title = article?.headline || $("h1").first().text().trim() || "Monopoly GO — News";
  const url = article?.url || sourceUrl || null;
  const publishDate = readPublishDate($, article);
  const heroImage = extractImageUrl(article?.image) || $('meta[property="og:image"]').attr("content") || null;

  const editorialImages = [
    ...new Set(
      $("img.editorial-image")
        .toArray()
        .map((el) => $(el).attr("src"))
        .filter(Boolean)
    ),
  ];

  // Category tags (e.g. "dig-minigame", "golden-blitz") shown as badges next to the
  // article's <h1>. Scoped to the article's own header, not the global site nav, which
  // also links to /tag/* pages.
  const tags = [
    ...new Set(
      $("h1")
        .first()
        .closest("header")
        .find('a[href^="/tag/"]')
        .toArray()
        .map((el) => $(el).attr("href")?.replace(/^\/tag\//, "").replace(/\/$/, ""))
        .filter(Boolean)
    ),
  ];

  return { title, url, publishDate, heroImage, editorialImages, tags };
}

// schema.org's `image` property may be a plain URL string, an ImageObject ({ url }),
// or an array of either — normalize to a single URL string.
function extractImageUrl(image) {
  const val = Array.isArray(image) ? image[0] : image;
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && typeof val.url === "string") return val.url;
  return null;
}

function readPublishDate($, article) {
  if (article?.datePublished) return new Date(article.datePublished);

  const metaTime = $('meta[property="article:published_time"]').attr("content");
  if (metaTime) return new Date(metaTime);

  const timeEl = $("time[datetime]").first().attr("datetime");
  if (timeEl) return new Date(timeEl);

  return null;
}

// Most post types publish a top-level `Article` JSON-LD object. Album-preview posts
// instead wrap a `BlogPosting` node inside an `@graph` array.
function readArticleLd($) {
  let article = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (article) return;
    let json;
    try {
      json = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const candidates = Array.isArray(json) ? json : json?.["@graph"] ? json["@graph"] : [json];
    article = candidates.find((j) => j && (j["@type"] === "Article" || j["@type"] === "BlogPosting")) || null;
  });
  return article;
}

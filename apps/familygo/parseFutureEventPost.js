import * as cheerio from "cheerio";

/**
 * Parse a Monopoly GO Wiki article page into the fields needed for a Discord post:
 * title, canonical URL, publish date, hero image, in-article "editorial" images, image
 * galleries, and category tags.
 *
 * Title/publishDate/hero image come from the page's Article/BlogPosting JSON-LD block,
 * which the site already publishes for SEO — more reliable than scraping the visual
 * layout, which varies per post type (plain article vs. custom event blocks). Some post
 * types (e.g. album previews) omit that JSON-LD, so each field falls back to a
 * DOM-scraped equivalent.
 *
 * The URL is the exception: `sourceUrl` (the href the news index linked) wins over the
 * JSON-LD `url`. When the wiki republishes an article at a new `-2` slug it copies the
 * old article's metadata across, so the JSON-LD there still names the *old* URL — which
 * is both the wrong link to post and, since dedupe keys on the URL, exactly how the
 * full Monster Mash album preview got skipped as "already posted".
 *
 * @param {string} html - Raw HTML of the article page.
 * @param {{ sourceUrl?: string }} [opts]
 * @returns {{
 *   title: string,
 *   url: string|null,
 *   publishDate: Date|null,
 *   heroImage: string|null,
 *   editorialImages: string[],
 *   galleries: Array<{ heading: string|null, images: string[] }>,
 *   tags: string[],
 * }}
 *  - editorialImages: the article body's standalone full-size images, in order.
 *  - galleries: the article body's image galleries (the wiki's `figure.pw-gallery` blocks —
 *    an album preview lists each wheel of sticker sets as one), each with the nearest
 *    preceding h2/h3 as its heading. Gallery images are not repeated in editorialImages.
 */
export function parseFutureEventPost(html, opts = {}) {
  const { sourceUrl } = opts;
  const $ = cheerio.load(html);

  const article = readArticleLd($);

  const title = article?.headline || $("h1").first().text().trim() || "Monopoly GO — News";
  const url = sourceUrl || article?.url || null;
  const publishDate = readPublishDate($, article);
  const heroImage = extractImageUrl(article?.image) || $('meta[property="og:image"]').attr("content") || null;

  // Galleries are scoped to the article body when the page has one; the tail of every
  // page carries "related stories" cards that must not be mistaken for content.
  const scope = $(".article-content").length ? ".article-content " : "";
  const galleries = $(`${scope}figure.pw-gallery`)
    .toArray()
    .map((el) => {
      const $gallery = $(el);
      const images = [
        ...new Set(
          $gallery
            .find("img")
            .toArray()
            .map((img) => $(img).attr("src"))
            .filter(Boolean)
        ),
      ];
      return { heading: nearestHeading($, $gallery), images };
    })
    .filter((g) => g.images.length);

  // Most posts tag their in-article images `img.editorial-image`, but some (the Blocks
  // Boutique guide) drop the class and just wrap each full-size image in a <figure> inside
  // the article body, so also accept those. The union is deduped by src, and the
  // `.article-content` scope keeps the small reward-breakdown icons out. Images that
  // belong to a gallery are reported under `galleries` instead.
  const editorialImages = [
    ...new Set(
      $("img.editorial-image, .article-content figure img")
        .toArray()
        .filter((el) => !$(el).closest(".pw-gallery").length)
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

  return { title, url, publishDate, heroImage, editorialImages, galleries, tags };
}

/**
 * Text of the closest h2/h3 before `$el` in document order, searching the element's own
 * preceding siblings first and then each ancestor's, stopping at the article body.
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio<any>} $el
 * @returns {string|null}
 */
function nearestHeading($, $el) {
  let $node = $el;
  while ($node.length && !$node.is("body, .article-content")) {
    const $heading = $node.prevAll("h2, h3").first();
    if ($heading.length) {
      const text = $heading.text().replace(/\s+/g, " ").trim();
      return text || null;
    }
    $node = $node.parent();
  }
  return null;
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

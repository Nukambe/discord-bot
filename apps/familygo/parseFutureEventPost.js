import * as cheerio from "cheerio";

/**
 * Parse a Monopoly GO Wiki article page into the fields needed for a Discord post:
 * title, canonical URL, publish date, hero image, and in-article "editorial" images.
 *
 * Title/url/publishDate/hero image come from the page's `Article` JSON-LD block, which
 * the site already publishes for SEO — more reliable than scraping the visual layout,
 * which varies per post type (plain article vs. custom event blocks).
 *
 * @param {string} html - Raw HTML of the article page.
 * @param {{ sourceUrl?: string }} [opts]
 * @returns {{ title: string, url: string|null, publishDate: Date|null, heroImage: string|null, editorialImages: string[] }}
 */
export function parseFutureEventPost(html, opts = {}) {
  const { sourceUrl } = opts;
  const $ = cheerio.load(html);

  const article = readArticleLd($);

  const title = article?.headline || $("h1").first().text().trim() || "Monopoly GO — News";
  const url = article?.url || sourceUrl || null;
  const publishDate = article?.datePublished ? new Date(article.datePublished) : null;
  const heroImage = extractImageUrl(article?.image) || $('meta[property="og:image"]').attr("content") || null;

  const editorialImages = [
    ...new Set(
      $("img.editorial-image")
        .toArray()
        .map((el) => $(el).attr("src"))
        .filter(Boolean)
    ),
  ];

  return { title, url, publishDate, heroImage, editorialImages };
}

// schema.org's `image` property may be a plain URL string, an ImageObject ({ url }),
// or an array of either — normalize to a single URL string.
function extractImageUrl(image) {
  const val = Array.isArray(image) ? image[0] : image;
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && typeof val.url === "string") return val.url;
  return null;
}

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
    const candidates = Array.isArray(json) ? json : [json];
    article = candidates.find((j) => j && j["@type"] === "Article") || null;
  });
  return article;
}

import * as cheerio from "cheerio";
import { toEstDateString } from "../../util/dateUtils.js";

/**
 * Parse the "Free Dice Links Today" (/latest-reward-links) page into individual
 * reward-link entries, keeping only the ones that first became available on
 * `targetEstDates` (America/New_York, "YYYY-MM-DD") — the page also carries
 * long-running links (partner rewards that stay up for months) which would
 * otherwise be re-posted every run.
 *
 * Accepts several dates because the caller scans a rolling window rather than a
 * single day: a link that appears late in the evening must still be found on the
 * next run even though the calendar date has since rolled over. Deduping against
 * what's already in the channel (see alreadyPosted.js) is what keeps the overlap
 * between windows from producing repeats.
 *
 * Passing a falsy `targetEstDates` skips the date filter entirely, returning every
 * card on the page — used in debug mode to get a link to post even when nothing
 * newly became available today.
 *
 * Each card looks like:
 *   <article class="reward-link">
 *     <h3>Free Rolls Reward Link</h3>
 *     <li class="reward-link__reward"><strong class="reward-link__reward-quantity">25 ×</strong><span>Rolls</span></li>
 *     <p class="reward-link__dates">Available <time datetime="...">...</time> through <time datetime="...">...</time></p>
 *     <a class="reward-link__cta" href="...">Claim reward</a>
 *   </article>
 *
 * @param {string} html - Raw HTML of the /latest-reward-links page.
 * @param {string|string[]} [targetEstDates] - e.g. "2026-08-01" or ["2026-08-01", "2026-07-31"];
 *   omit/falsy to skip the date filter.
 * @param {{ debug?: boolean }} [opts]
 * @returns {Array<{ quantity: string, rewardName: string, startDate: Date, endDate: Date|null, claimUrl: string }>}
 */
export function getFreeDiceLinks(html, targetEstDates, opts = {}) {
  const { debug = false } = opts;
  if (!html) return [];

  const wanted = targetEstDates
    ? new Set(Array.isArray(targetEstDates) ? targetEstDates : [targetEstDates])
    : null;

  const $ = cheerio.load(html);
  const links = [];

  $("article.reward-link").each((_, el) => {
    const $card = $(el);

    const claimUrl = $card.find("a.reward-link__cta").attr("href")?.trim();
    if (!claimUrl) return;

    const quantity = $card.find(".reward-link__reward-quantity").first().text().replace(/[×x\s]+$/i, "").trim();
    const rewardName = $card.find(".reward-link__reward span").first().text().trim() || "Reward";

    const dateEls = $card.find(".reward-link__dates time");
    const startAttr = dateEls.eq(0).attr("datetime");
    const endAttr = dateEls.eq(1).attr("datetime");
    if (!startAttr) return;

    const startDate = new Date(startAttr);
    if (Number.isNaN(startDate.getTime())) return;
    const endDate = endAttr ? new Date(endAttr) : null;

    if (wanted && !wanted.has(toEstDateString(startDate))) return;

    links.push({ quantity, rewardName, startDate, endDate, claimUrl });
  });

  if (debug) {
    console.log(
      `[getFreeDiceLinks] target=${wanted ? [...wanted].join(",") : "any"} found=${links.length}:`,
      links.map((l) => l.claimUrl)
    );
  }

  return links;
}

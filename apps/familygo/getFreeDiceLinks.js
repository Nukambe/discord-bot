import * as cheerio from "cheerio";
import { toEstDateString } from "../../util/dateUtils.js";

/**
 * Parse the "Free Dice Links Today" (/latest-reward-links) page into individual
 * reward-link entries, keeping only the ones that first became available on
 * `targetEstDate` (America/New_York, "YYYY-MM-DD") — links that were already
 * available on a previous day were already posted then, so re-including them
 * here would duplicate them.
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
 * @param {string} targetEstDate - e.g. "2026-08-01"
 * @param {{ debug?: boolean }} [opts]
 * @returns {Array<{ quantity: string, rewardName: string, startDate: Date, endDate: Date|null, claimUrl: string }>}
 */
export function getFreeDiceLinks(html, targetEstDate, opts = {}) {
  const { debug = false } = opts;
  if (!html || !targetEstDate) return [];

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

    if (toEstDateString(startDate) !== targetEstDate) return;

    links.push({ quantity, rewardName, startDate, endDate, claimUrl });
  });

  if (debug) {
    console.log(
      `[getFreeDiceLinks] target=${targetEstDate} found=${links.length}:`,
      links.map((l) => l.claimUrl)
    );
  }

  return links;
}

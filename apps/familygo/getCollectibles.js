import { fetchManyWithPlaywright } from "../../util/fetchWithPlaywright.js";
import { outputToFile } from "../../util/outputToFile.js";

/**
 * The three collectible category pages the spoilers post watches, in the order they
 * appear in the post. `key` is also the key each category's seen-item state is stored
 * under in db.lastPosts.spoilers, so renaming one resets that category's state.
 */
export const COLLECTIBLE_CATEGORIES = [
  { key: "diceSkins", heading: "Dice Skins", url: "https://monopolygo.wiki/wiki/2465-dice-skins" },
  { key: "shields", heading: "Shields", url: "https://monopolygo.wiki/wiki/2-shields" },
  { key: "tokens", heading: "Tokens", url: "https://monopolygo.wiki/wiki/1-tokens" },
];

/** Landing page the post credits as its source (the three categories live under it). */
export const COLLECTIBLES_SOURCE_URL = "https://monopolygo.wiki/wiki";

/**
 * How many times a category page is attempted per run. The wiki intermittently answers with
 * its own gateway error ("upstream connect error or disconnect/reset before headers") instead
 * of the page, which parses to nothing. This job runs once a night with no retry window of
 * its own, so one blip would otherwise cost a whole day's spoilers for that category.
 */
const FETCH_ATTEMPTS = 2;

/**
 * Fetch all three category pages through a single browser launch and parse each one's
 * items. One launch for all three is deliberate: the wiki is behind Cloudflare, which
 * rejects headless Chrome, so every fetch opens a *visible* window on the packaged
 * desktop build — three separate calls would mean three windows popping up at 7:30pm.
 *
 * A category whose page failed to load or parse is simply absent from the result rather
 * than present-but-empty. That distinction matters upstream: an empty list would look
 * like "this category has no items" and let the caller overwrite good seen-item state
 * with nothing, re-posting the whole category on the next run.
 *
 * Only the categories that came back unusable are retried, and only on that rare path does
 * a run cost a second browser window — the normal case stays at one.
 *
 * @param {{ debug?: boolean }} [opts] - debug: verbose logs + HTML dumps to ./debug.
 * @returns {Promise<Map<string, Array<{ itemId: number, name: string, imageUrl: string }>>>}
 *   Category key → its items in the wiki's own order (newest first). Only successful
 *   categories are present.
 */
export async function getCollectibles(opts = {}) {
  const { debug = false } = opts;
  const byCategory = new Map();
  let pending = COLLECTIBLE_CATEGORIES;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS && pending.length; attempt++) {
    console.log(
      attempt === 1
        ? `🔎 Fetching ${pending.length} collectible category page(s)...`
        : `🔁 Retrying ${pending.length} category page(s) that didn't come back usable...`
    );
    const pages = await fetchManyWithPlaywright(
      pending.map((c) => c.url),
      { waitForSelector: "main" }
    );

    const failed = [];
    for (const [i, category] of pending.entries()) {
      const html = pages[i];
      if (debug && html) await outputToFile(`./debug/collectibles-${category.key}.html`, html);

      const items = html ? parseCollectibleItems(html, { debug }) : [];
      if (!items.length) {
        console.warn(
          `⚠️ ${category.heading}: ${html ? "no items in the page payload" : "page didn't load"} (attempt ${attempt})`
        );
        failed.push(category);
        continue;
      }
      console.log(`✅ ${category.heading}: parsed ${items.length} item(s)`);
      byCategory.set(category.key, items);
    }
    pending = failed;
  }

  for (const category of pending) {
    console.error(
      `❌ Giving up on ${category.heading} (${category.url}) for this run — its stored state is left alone, so the next run picks it up`
    );
  }

  return byCategory;
}

/**
 * Pull a category page's item cards out of its embedded Next.js flight data.
 *
 * The cards are server-rendered from an `initialItems` array in the flight payload —
 * records shaped `{"slug":"82255","itemId":82255,"parentId":2465,"category":"2465",
 * "categoryName":"Dice Skins","name":"ACME TNT","metadata":"From Dice Skins",
 * "imageTone":"bg-[...]","image":"https://cdn-asset.monopolygo.wiki/...png"}`, escaped
 * inside a script string (hence the unescaping pass below).
 *
 * Reading the JSON rather than the DOM is what makes the numeric `itemId` available —
 * the rendered card exposes it only inside its href — and that id is the only stable
 * handle on an item: **no record carries a date**. The category record has a
 * `releaseDate` field, but it is `$undefined` on all three pages, so "what's new" can
 * only be answered by remembering which ids were already seen (see
 * postCollectibleSpoilers.js), never by comparing dates.
 *
 * Only the first page of items is parsed, which is all that's needed: the pages are
 * infinite-scroll (`hasMore: true`) but ordered newest-first, so anything newly added
 * is in this first batch. Note the order is the wiki's own, *not* itemId order — ids
 * within one release wave are interleaved (82255, 82218, 82225, 82256, ...), which is
 * why callers can't treat "highest id seen" as a watermark.
 *
 * @param {string} html - A category page's rendered HTML.
 * @param {{ debug?: boolean }} [opts]
 * @returns {Array<{ itemId: number, name: string, imageUrl: string }>}
 *   Items in page order (newest first), deduped by id. Empty when the payload is
 *   missing or unparseable.
 */
export function parseCollectibleItems(html, opts = {}) {
  const { debug = false } = opts;
  if (!html) return [];

  const raw = extractInitialItemsArray(html);
  if (!raw) {
    console.warn("[parseCollectibleItems] No initialItems array found in the page payload");
    return [];
  }

  let records;
  try {
    // The array sits inside a script string, so its quotes arrive as \". Parsing it as a
    // JSON string first undoes that escaping; the second parse reads the array itself.
    // A page served without the escaping (a saved fixture, say) parses directly.
    records = JSON.parse(raw.includes('\\"') ? JSON.parse(`"${raw}"`) : raw);
  } catch (err) {
    console.warn("[parseCollectibleItems] Unparseable initialItems array:", err?.message);
    return [];
  }
  if (!Array.isArray(records)) return [];

  const byId = new Map();
  for (const record of records) {
    const itemId = Number(record?.itemId);
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    const imageUrl = typeof record?.image === "string" && record.image !== "$undefined" ? record.image : "";
    if (!Number.isFinite(itemId) || !name || name === "$undefined") {
      if (debug) console.warn("[parseCollectibleItems] Skipping incomplete record:", record?.itemId, record?.name);
      continue;
    }
    if (byId.has(itemId)) continue;
    byId.set(itemId, { itemId, name, imageUrl });
  }

  const items = [...byId.values()];
  if (debug) console.log(`[parseCollectibleItems] records=${records.length} unique=${items.length}`);
  return items;
}

/**
 * Slice out the raw (still script-escaped) text of the payload's `initialItems` array.
 *
 * Bracket counting rather than a regex: item records carry an `imageTone` value like
 * `bg-[linear-gradient(135deg,#f7fff6,#fff7d9,#e9f5ff)]`, so brackets appear inside the
 * array — they're balanced, which is exactly what a depth counter handles and what makes
 * a naive "up to the next ]" match wrong.
 *
 * @param {string} html
 * @returns {string|null} The `[...]` text, or null when the array isn't present/closed.
 */
function extractInitialItemsArray(html) {
  const anchor = html.indexOf("initialItems");
  if (anchor === -1) return null;
  const open = html.indexOf("[", anchor);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "[") depth++;
    else if (html[i] === "]" && --depth === 0) return html.slice(open, i + 1);
  }
  return null;
}

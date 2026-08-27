/**
 * Turn a wiki-listed claim link into the real Scopely link, plus the reward's identity.
 *
 * monopolygo.wiki doesn't publish Scopely's links directly — it wraps them in its own
 * disposable shortener (`mplygo.wiki/<slug>`), and it mints a fresh slug whenever a card
 * is re-listed. The same reward therefore shows up under several URLs (the article page
 * and /mogo-tools/reward-links were serving different slugs for the same four rewards on
 * the day this was written), which is exactly why URL-keyed dedupe was re-posting rewards
 * users had already claimed: the link was new, the reward wasn't.
 *
 * Following the redirects fixes both halves of that:
 *   https://mplygo.wiki/duja1B          (wiki wrapper — disposable)
 *     -> https://mply.io/oe7O0T1CVHA    (Scopely's own link — what we post)
 *       -> monopolygo://reward-link/Discord_26Aug_3948394   (campaign id — the real identity)
 *
 * We post the first non-wiki hop rather than the deepest one because the chain bottoms out
 * in a `monopolygo://` app scheme (or an Adjust `adj.st` URL loaded down with tracking
 * params), neither of which is a usable Discord link. `mply.io/<token>` is Scopely's, is a
 * plain https link, and is stable for a given campaign — so posting it makes the
 * channel-scan dedupe in alreadyPosted.js meaningful again.
 *
 * Plain HTTPS, deliberately: these shorteners answer a bare HEAD, so this needs no
 * Playwright and opens no Chrome window on the packaged desktop build (see
 * util/fetchWithPlaywright.js for why that matters — every wiki page fetch is visible to
 * the end user, so it's a budget; redirect hops are not).
 */

/** Redirect hops to follow before giving up. Real chains observed are 1-3 long. */
const MAX_HOPS = 6;

/** Per-hop timeout. A hung shortener must not stall the whole free-dice run. */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * A mobile UA is not cosmetic: with a desktop UA, mply.io sends you to the App Store
 * listing instead of the reward deep link, and the campaign id never appears in the chain.
 */
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

/** True for the wiki's own shortener/domains — the hops worth unwrapping past. */
function isWikiHost(url) {
  try {
    return new URL(url).host.toLowerCase().endsWith(".wiki");
  } catch {
    return false;
  }
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

/**
 * Pull the campaign id out of any hop that carries one, e.g. `Disc250825` from
 * `monopolygo://reward-link/Disc250825` or `https://2tdd.adj.st/reward-link/Disc250825?...`.
 * Lowercased, since it's only ever used as a comparison key.
 * @param {string} url
 * @returns {string|null}
 */
export function extractRewardId(url) {
  const match = /reward-link\/([^/?#\s]+)/i.exec(String(url || ""));
  return match ? decodeURIComponent(match[1]).toLowerCase() : null;
}

/**
 * One hop: return the raw `Location` header, or null if this URL is the end of the chain.
 * HEAD first (cheapest), falling back to GET for servers that refuse it.
 */
async function fetchLocation(url) {
  for (const method of ["HEAD", "GET"]) {
    const res = await fetch(url, {
      method,
      redirect: "manual",
      headers: { "User-Agent": MOBILE_UA, Accept: "*/*" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Nothing here needs the body, and leaving it unread keeps the socket busy.
    res.body?.cancel?.().catch(() => {});

    if (method === "HEAD" && [400, 403, 405, 501].includes(res.status)) continue;
    return res.headers.get("location");
  }
  return null;
}

/**
 * Resolve a wiki claim link to the link we should actually post and the reward's campaign id.
 *
 * Fails open on purpose: a shortener outage, a timeout or an unexpected chain returns the
 * original URL with a null id, which is exactly the behaviour this module replaced. A
 * duplicate post is a far better failure than a link that never goes out.
 *
 * @param {string} claimUrl - href from a `.reward-link__cta` on the wiki.
 * @param {{ debug?: boolean }} [opts]
 * @returns {Promise<{ url: string, rewardId: string|null }>} `url` is the link to post.
 */
export async function resolveRewardLink(claimUrl, opts = {}) {
  const { debug = false } = opts;
  if (!claimUrl) return { url: claimUrl, rewardId: null };

  let current = claimUrl;
  let canonical = isWikiHost(claimUrl) ? null : claimUrl;
  let rewardId = extractRewardId(claimUrl);

  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const location = await fetchLocation(current);
      if (!location) break;

      let next = location;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(location)) {
        // Relative Location — resolve it against the URL that issued it.
        try {
          next = new URL(location, current).toString();
        } catch {
          break;
        }
      }

      const id = extractRewardId(next);
      if (id) rewardId = id;

      // A non-http scheme is the app deep link: the chain ends here.
      if (!isHttpUrl(next)) break;
      if (!canonical && !isWikiHost(next)) canonical = next;
      current = next;
    }
  } catch (err) {
    console.warn(`[resolveRewardLink] Couldn't resolve ${claimUrl}: ${err?.message}`);
  }

  const resolved = { url: canonical ?? claimUrl, rewardId };
  if (debug) console.log(`[resolveRewardLink] ${claimUrl} -> ${resolved.url} (id=${resolved.rewardId ?? "none"})`);
  return resolved;
}

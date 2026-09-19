import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

/**
 * When running as a packaged pkg executable, process.execPath is the real path
 * of the .exe on disk (not a virtual snapshot path), so a `chrome-win/` folder
 * shipped next to it is a normal sibling file. Only used as a fallback when
 * CHROME_PATH isn't set, so a source checkout / Heroku deploy is unaffected.
 */
function bundledChromePath() {
  if (!process.pkg) return null;
  const candidate = path.join(path.dirname(process.execPath), 'chrome-win', 'chrome.exe');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Fetch a Monopoly GO wiki page using a real browser.
 * @param {string} url - Full URL to fetch (e.g. https://monopolygo.wiki/todays-events-...)
 * @param {{ waitForSelector?: string }} [opts]
 *  - waitForSelector: if provided, wait for this selector to appear (up to 15s) instead of
 *    just a flat 3s timeout, before reading page content. Falls through on timeout so callers
 *    still get whatever HTML was captured.
 * @returns {Promise<string>} The rendered page HTML.
 */
export async function fetchWithPlaywright(url, opts = {}) {
  const [html] = await fetchManyWithPlaywright([url], opts);
  if (html == null) throw new Error(`[Playwright] Failed to fetch ${url}`);
  return html;
}

/**
 * Fetch several pages through a single browser launch, one tab reused for all of them.
 *
 * Every launch opens a *visible* Chrome window on the packaged desktop build (Cloudflare
 * rejects headless, see below), so a caller that needs three sibling pages should ask for
 * them together rather than calling fetchWithPlaywright three times — one window popping up
 * instead of three is the whole point.
 *
 * Unlike fetchWithPlaywright, a page that fails yields null in its slot rather than
 * throwing, so one bad URL doesn't cost the caller the pages that did load.
 *
 * @param {string[]} urls - Pages to fetch, in order.
 * @param {{ waitForSelector?: string }} [opts] - Applied to every page (see fetchWithPlaywright).
 * @returns {Promise<Array<string|null>>} Rendered HTML per input url, same order; null on failure.
 */
export async function fetchManyWithPlaywright(urls, opts = {}) {
  const { waitForSelector = null } = opts;
  console.log('[Playwright] Launching browser...');
  const browser = await chromium.launch({
    // Cloudflare fingerprints headless mode itself, not just the source IP —
    // headless is challenged even from a residential connection, while headed
    // passes. Defaults to headless so the Heroku dyno keeps its old behavior;
    // set CHROME_HEADLESS=false on a host with a real desktop session.
    headless: process.env.CHROME_HEADLESS !== 'false',
    executablePath: process.env.CHROME_PATH || bundledChromePath() || "/app/.chrome-for-testing/chrome-linux64/chrome",
    // Site fronts requests with Cloudflare bot management, which flags the
    // stock automation flag and (previously) a hardcoded UA header that didn't
    // match the real binary's navigator.userAgent/Client-Hints.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  try {
    const results = [];
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (waitForSelector) {
          await page.waitForSelector(waitForSelector, { timeout: 15000 }).catch(() => {});
        } else {
          await page.waitForTimeout(3000); // wait a bit for dynamic content
        }
        results.push(await page.content());
      } catch (err) {
        console.error(`[Playwright] Failed to load ${url}:`, err?.message || err);
        results.push(null);
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}

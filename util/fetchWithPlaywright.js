import { chromium } from 'playwright-core';

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
  const { waitForSelector = null } = opts;
  console.log('[Playwright] Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/app/.chrome-for-testing/chrome-linux64/chrome",
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  // Pretend to be a real Chrome user
  await page.setExtraHTTPHeaders({
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 15000 }).catch(() => {});
    } else {
      await page.waitForTimeout(3000); // wait a bit for dynamic content
    }
    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

import { chromium } from "playwright-core";
import "dotenv/config";

/**
 * streamviewer — opens methstreams in a Chrome window that strips every game
 * page down to the site header, the link selector and the video player, with
 * the player stretched to fill the window. League pages are left alone so the
 * site can still be browsed normally. See README.md.
 */

const START_URL = process.argv[2] || "https://methstreams.gs/league/nbastreams";
const CHROME_PATH =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

// Serialized into the page as an init script, so it runs at the start of every
// navigation (and in every frame) — it must be self-contained. Only top-level
// /stream/ pages are stripped.
function stripStreamPage() {
  if (window.top !== window || !location.pathname.startsWith("/stream/")) return;

  const css = `
    html, body { height: 100% !important; margin: 0 !important; padding: 0 !important;
                 overflow: hidden !important; background: #111 !important; }
    body { display: flex !important; flex-direction: column !important; }
    body > *:not(header):not(.player-container) { display: none !important; }
    header { flex: 0 0 auto !important; }
    .player-container { flex: 1 1 auto !important; display: flex !important; flex-direction: column !important;
                        min-height: 0 !important; width: 100% !important; max-width: none !important;
                        margin: 0 !important; padding: 0 !important; box-sizing: border-box !important; }
    #linkSelector { flex: 0 0 auto !important; margin: 6px 0 !important; }
    #videoPlayer { flex: 1 1 auto !important; min-height: 0 !important; height: auto !important;
                   width: 100% !important; max-width: none !important; margin: 0 !important;
                   padding: 0 !important; border-radius: 0 !important; }
    #videoPlayer iframe { width: 100% !important; height: 100% !important; border-radius: 0 !important; display: block; }
  `;

  // Init scripts run before <html> exists, so wait for the parser to create it.
  const addStyle = () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.documentElement.appendChild(style);
  };
  if (document.documentElement) addStyle();
  else new MutationObserver((_, obs) => {
    if (document.documentElement) { obs.disconnect(); addStyle(); }
  }).observe(document, { childList: true });

  const strip = () => {
    for (const el of [...document.body.children]) {
      if (el.tagName !== "HEADER" && !el.classList.contains("player-container") && el.tagName !== "STYLE") el.remove();
    }
  };
  document.addEventListener("DOMContentLoaded", () => {
    strip();
    // Late-injected overlays/ads get removed as soon as they appear.
    new MutationObserver(strip).observe(document.body, { childList: true });
  });
}

const browser = await chromium.launch({
  headless: false,
  executablePath: CHROME_PATH,
  args: ["--start-maximized"],
});
const context = await browser.newContext({ viewport: null });
await context.addInitScript(stripStreamPage);
const page = await context.newPage();

// Ad scripts love opening popunder tabs — close anything that isn't our page.
context.on("page", (p) => { if (p !== page) p.close().catch(() => {}); });

await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("streamviewer open — browse freely; game pages get stripped. Close the window to exit.");
await new Promise((resolve) => browser.on("disconnected", resolve));

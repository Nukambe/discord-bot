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

// Also an init script, but for every frame on a /stream/ page — the <video>
// lives inside the third-party player's iframe (sometimes nested), which the
// top page can't reach. Restarts any video that pauses or stalls on its own;
// a pause right after a click or key press in that frame counts as the user's
// and is left alone until they press play again.
function keepPlaying() {
  if (window.top === window && !location.pathname.startsWith("/stream/")) return;

  const log = (msg) => console.log(`[streamviewer] ${msg}`);
  const userPaused = new WeakSet();
  const lastTimes = new WeakMap();
  let lastInteraction = 0;
  const touched = () => { lastInteraction = Date.now(); };
  addEventListener("pointerdown", touched, true);
  addEventListener("keydown", touched, true);

  const resume = (v, why) => {
    v.play().then(() => log(`resumed (${why})`)).catch((err) => {
      // Autoplay with sound refused — muted playback is always allowed.
      if (err.name !== "NotAllowedError" || v.muted) return;
      v.muted = true;
      v.play().then(() => log(`resumed muted (${why}) — unmute in the player`)).catch(() => {});
    });
  };

  // Media events don't bubble, but they do reach a capturing listener.
  document.addEventListener("pause", (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    if (Date.now() - lastInteraction < 1500) { userPaused.add(v); return; }
    setTimeout(() => { if (v.paused && !v.ended && !userPaused.has(v)) resume(v, "paused"); }, 500);
  }, true);
  document.addEventListener("play", (e) => userPaused.delete(e.target), true);

  setInterval(() => {
    for (const v of document.querySelectorAll("video")) {
      if (v.ended || userPaused.has(v)) continue;
      if (v.paused) {
        if (v.readyState > 0 || v.currentSrc) resume(v, "found paused");
        continue;
      }
      // Playing but frozen: if there's buffered video ahead, it's stuck on a
      // gap — jump past it to the newest buffered point.
      const [prev, count] = lastTimes.get(v) || [-1, 0];
      const stuck = v.currentTime === prev ? count + 1 : 0;
      lastTimes.set(v, [v.currentTime, stuck]);
      if (stuck >= 3 && v.buffered.length) {
        const end = v.buffered.end(v.buffered.length - 1);
        if (end - v.currentTime > 0.5) {
          v.currentTime = end - 0.3;
          lastTimes.delete(v);
          log("skipped a stall");
        }
      }
    }
  }, 2000);
}

const browser = await chromium.launch({
  headless: false,
  executablePath: CHROME_PATH,
  // Let the player start (and be restarted) without a click first.
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: null });
await context.addInitScript(stripStreamPage);
await context.addInitScript(keepPlaying);
const page = await context.newPage();

// Ad scripts love opening popunder tabs — close anything that isn't our page.
context.on("page", (p) => { if (p !== page) p.close().catch(() => {}); });
page.on("console", (msg) => { if (msg.text().startsWith("[streamviewer]")) console.log(msg.text()); });

await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("streamviewer open — browse freely; game pages get stripped. Close the window to exit.");
// Closing the window doesn't always take Chrome's process down with it, so
// treat the page closing as the exit signal too, not just the disconnect.
await new Promise((resolve) => {
  browser.on("disconnected", resolve);
  page.on("close", resolve);
});
await browser.close().catch(() => {});

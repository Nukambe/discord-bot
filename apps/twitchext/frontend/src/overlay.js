import { createStateBuffer } from './state.js';

/**
 * The overlay itself: a transparent page Twitch stacks on top of the video.
 *
 * Mouse handling note — the obvious implementation is one full-player element
 * listening for mousemove. Don't: that element swallows every click on the
 * player, so viewers can't pause, scrub or open settings, and Twitch rejects
 * extensions that do it during review. Instead we place one small element per
 * visible item and leave everything else pointer-transparent, so the only
 * pixels we intercept are the ones we actually have a tooltip for.
 */

const DEFAULT_DELAY_MS = 8000;
const MAX_DELAY_MS = 30000;
const POLL_INTERVAL_MS = 1000;

const root = document.getElementById('zones');
const tooltip = document.getElementById('tooltip');
const status = document.getElementById('status');
const delayInput = document.getElementById('delay');
const delayValue = document.getElementById('delay-value');
const settings = document.getElementById('settings');

let auth = null;
let items = {};
let delayMs = DEFAULT_DELAY_MS;
let hovered = null;
let renderedKey = '';

const state = createStateBuffer({
  getToken: () => auth?.token,
  onError: err => setStatus(`offline — ${err.message}`),
});

// --- Twitch extension helper wiring ---

window.Twitch.ext.onAuthorized(async authorized => {
  auth = authorized;
  delayMs = loadDelay(authorized.channelId);
  applyDelayToUi();

  try {
    items = await state.fetchItems();
    setStatus('');
  } catch (err) {
    setStatus(`could not load item data — ${err.message}`);
  }

  state.poll();
});

// PubSub is a low-rate nudge, not the main feed (see ebs/pubsub.js) — it just
// gets a freshly-loaded viewer to first paint without waiting for a poll.
window.Twitch.ext.listen('broadcast', (_target, _contentType, message) => {
  try {
    state.ingest(JSON.parse(message));
  } catch {
    /* malformed broadcast is not worth surfacing to the viewer */
  }
});

// The streamer's configured default delay, if they set one.
window.Twitch.ext.configuration?.onChanged?.(() => {
  const raw = window.Twitch.ext.configuration.broadcaster?.content;
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.delayMs === 'number' && !hasStoredDelay(auth?.channelId)) {
      delayMs = clampDelay(parsed.delayMs);
      applyDelayToUi();
    }
  } catch {
    /* ignore malformed broadcaster config */
  }
});

setInterval(() => state.poll(), POLL_INTERVAL_MS);
requestAnimationFrame(render);

// --- rendering ---

function render() {
  requestAnimationFrame(render);

  const frame = state.frame;
  const snapshot = state.at(delayMs);

  if (!frame || !snapshot || !snapshot.items.length) {
    if (renderedKey !== '') {
      root.replaceChildren();
      renderedKey = '';
      hideTooltip();
    }
    return;
  }

  // Rebuilding the DOM 60x/second would be wasteful and would also cancel the
  // in-flight hover. Only touch it when the visible set actually changes.
  const key = snapshot.items.map(i => `${i.id}@${i.x.toFixed(4)},${i.y.toFixed(4)}`).join('|');
  if (key === renderedKey) return;
  renderedKey = key;

  // The zone under the cursor is about to be replaced, so its mouseleave will
  // never fire. Drop the tooltip rather than leaving a stale one on screen; if
  // the cursor is still over an item, mouseenter re-fires on the next move.
  hideTooltip();

  const zones = snapshot.items.map(item => {
    const el = document.createElement('div');
    el.className = 'zone';

    // game space -> stream space, applying the streamer's OBS layout rect.
    el.style.left = `${(frame.x + item.x * frame.w) * 100}%`;
    el.style.top = `${(frame.y + item.y * frame.h) * 100}%`;
    el.style.width = `${item.w * frame.w * 100}%`;
    el.style.height = `${item.h * frame.h * 100}%`;

    el.addEventListener('mouseenter', () => showTooltip(item, el));
    el.addEventListener('mouseleave', () => {
      if (hovered === item.id) hideTooltip();
    });

    return el;
  });

  root.replaceChildren(...zones);
}

function showTooltip(item, zoneEl) {
  const data = items[item.id];
  if (!data) return;

  hovered = item.id;
  tooltip.replaceChildren(
    el('div', 'tooltip-title', data.name || item.id),
    ...(data.lines || []).map(line => el('div', 'tooltip-line', line))
  );

  tooltip.hidden = false;

  // Anchor above the item, then pull back inside the player if that overflows.
  const zone = zoneEl.getBoundingClientRect();
  const box = tooltip.getBoundingClientRect();
  const margin = 8;

  let left = zone.left + zone.width / 2 - box.width / 2;
  left = Math.max(margin, Math.min(window.innerWidth - box.width - margin, left));

  let top = zone.top - box.height - margin;
  if (top < margin) top = zone.bottom + margin;

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip() {
  hovered = null;
  tooltip.hidden = true;
}

// --- viewer delay control ---

delayInput.addEventListener('input', () => {
  delayMs = clampDelay(Number(delayInput.value));
  applyDelayToUi();
  storeDelay(auth?.channelId, delayMs);
  renderedKey = ''; // force a re-render at the new offset
});

settings.addEventListener('click', () => {
  document.body.classList.toggle('show-settings');
});

function applyDelayToUi() {
  delayInput.value = String(delayMs);
  delayValue.textContent = `${(delayMs / 1000).toFixed(1)}s`;
}

function clampDelay(ms) {
  return Math.min(MAX_DELAY_MS, Math.max(0, Number.isFinite(ms) ? ms : DEFAULT_DELAY_MS));
}

// Delay is per-channel: a viewer's latency to one streamer says nothing about
// another, and low-latency mode changes it on the same channel too.
function delayKey(channelId) {
  return `twitchext:delay:${channelId || 'unknown'}`;
}

function loadDelay(channelId) {
  try {
    const raw = localStorage.getItem(delayKey(channelId));
    return raw === null ? DEFAULT_DELAY_MS : clampDelay(Number(raw));
  } catch {
    return DEFAULT_DELAY_MS; // storage blocked in the sandboxed iframe
  }
}

function hasStoredDelay(channelId) {
  try {
    return localStorage.getItem(delayKey(channelId)) !== null;
  } catch {
    return false;
  }
}

function storeDelay(channelId, ms) {
  try {
    localStorage.setItem(delayKey(channelId), String(ms));
  } catch {
    /* non-fatal: the setting just won't persist */
  }
}

function setStatus(text) {
  status.textContent = text;
  status.hidden = !text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

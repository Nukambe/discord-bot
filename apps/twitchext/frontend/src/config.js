import { resolveEbsUrl } from './env.js';

/**
 * Broadcaster configuration page.
 *
 * Two jobs: store the default stream delay in Twitch's configuration service,
 * and give the streamer a way to tell whether the companion app is actually
 * feeding the EBS — that's the failure everyone hits first, and without this
 * page the only symptom is "no tooltips" with nowhere to look.
 */

const base = resolveEbsUrl();

const statusEl = document.getElementById('status');
const detailsEl = document.getElementById('details');
const delayInput = document.getElementById('delay');
const delayValue = document.getElementById('delay-value');
const saveButton = document.getElementById('save');
const savedFlag = document.getElementById('saved');
const frameRect = document.getElementById('frame-rect');
const frameText = document.getElementById('frame-text');

let auth = null;

window.Twitch.ext.onAuthorized(authorized => {
  auth = authorized;

  const existing = readBroadcasterConfig();
  if (typeof existing.delayMs === 'number') {
    delayInput.value = String(existing.delayMs);
  }
  renderDelay();

  refresh();
  setInterval(refresh, 5000);
});

window.Twitch.ext.configuration?.onChanged?.(() => {
  const existing = readBroadcasterConfig();
  if (typeof existing.delayMs === 'number') {
    delayInput.value = String(existing.delayMs);
    renderDelay();
  }
});

delayInput.addEventListener('input', () => {
  renderDelay();
  savedFlag.hidden = true;
});

saveButton.addEventListener('click', () => {
  window.Twitch.ext.configuration.set('broadcaster', '1', JSON.stringify({ delayMs: Number(delayInput.value) }));
  savedFlag.hidden = false;
});

async function refresh() {
  if (!auth?.token) return;

  try {
    const res = await fetch(`${base}/api/state`, {
      headers: { authorization: `Bearer ${auth.token}` },
    });
    if (!res.ok) throw new Error(`EBS returned ${res.status}`);

    const body = await res.json();
    const latest = body.snapshots?.at(-1);
    // A snapshot older than a few seconds means the companion died or the
    // emulator closed — distinct from "never connected", so say which.
    const age = latest ? body.serverTime - latest.t : null;

    if (!latest) {
      setStatus('waiting', 'No game data yet — start the companion app on your streaming PC.');
      detailsEl.replaceChildren();
    } else if (age > 10_000) {
      setStatus('stale', `Last update ${Math.round(age / 1000)}s ago — the companion app may have stopped.`);
    } else {
      setStatus('ok', 'Connected — game data is flowing.');
    }

    if (latest) {
      detailsEl.replaceChildren(
        detail('Items on screen', String(latest.items.length)),
        detail('Last update', age === null ? '—' : `${(age / 1000).toFixed(1)}s ago`),
        detail('Item database', `v${body.itemsVersion ?? '?'}`)
      );
    }

    renderFrame(body.frame);
  } catch (err) {
    setStatus('error', `Can't reach the backend — ${err.message}`);
  }
}

function renderFrame(frame) {
  if (!frame) {
    frameRect.style.display = 'none';
    frameText.textContent = 'Waiting for the companion app…';
    return;
  }

  frameRect.style.display = 'block';
  frameRect.style.left = `${frame.x * 100}%`;
  frameRect.style.top = `${frame.y * 100}%`;
  frameRect.style.width = `${frame.w * 100}%`;
  frameRect.style.height = `${frame.h * 100}%`;

  const pct = n => `${(n * 100).toFixed(1)}%`;
  frameText.textContent =
    `Game occupies ${pct(frame.w)} × ${pct(frame.h)} of the canvas, ` +
    `offset ${pct(frame.x)} from the left and ${pct(frame.y)} from the top.`;
}

function readBroadcasterConfig() {
  try {
    return JSON.parse(window.Twitch.ext.configuration.broadcaster?.content || '{}');
  } catch {
    return {};
  }
}

function renderDelay() {
  delayValue.textContent = `${(Number(delayInput.value) / 1000).toFixed(1)}s`;
}

function setStatus(kind, text) {
  statusEl.className = `status status--${kind}`;
  statusEl.textContent = text;
}

function detail(label, value) {
  const wrap = document.createDocumentFragment();
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  wrap.append(dt, dd);
  return wrap;
}

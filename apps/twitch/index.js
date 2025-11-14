import tmi from 'tmi.js';
import { request } from 'undici';
import { loadCommands } from './lib/commandLoader.js';
import { parseCommand, isModOrBroadcaster, safeSay } from './lib/utils.js';
import { onCooldown } from './lib/cooldown.js';
import { persistRefreshToHeroku } from './lib/persistRefreshToken.js';
import { sanitizeInput } from "../../util/sanitize.js";
import 'dotenv/config';

// --- load commands from ./commands ---
const registry = await loadCommands(); // Map<name|alias, def>

let accessToken = process.env.TWITCH_OAUTH_TOKEN?.replace(/^oauth:/, ''); // raw token (no 'oauth:')
let refreshToken = process.env.TWITCH_REFRESH;
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;

const channels = [process.env.TWITCH_CHANNEL];

// --- tmi.js client factory (so we can rebuild with new token) ---
function makeClient(token) {
  return new tmi.Client({
    options: { debug: true },
    identity: {
      username: process.env.TWITCH_BOT_USERNAME,
      password: `oauth:${token}`, // tmi.js expects 'oauth:' prefix
    },
    channels,
    connection: { reconnect: true },
  });
}

let client = makeClient(accessToken);

// ---- token refresh helpers ----
async function exchangeRefreshToken() {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }).toString();

  const res = await request('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (res.statusCode !== 200) {
    const txt = await res.body.text();
    throw new Error(`Refresh failed (${res.statusCode}): ${txt}`);
  }

  const data = await res.body.json();
  // data: { access_token, refresh_token, expires_in, ... }
  accessToken = data.access_token;
  if (data.refresh_token) {
    // Twitch may rotate it
    await persistRefreshToHeroku(data.refresh_token);
    process.env.TWITCH_REFRESH = data.refresh_token;
    refreshToken = data.refresh_token;
  }; 
  scheduleRefresh(data.expires_in);
  return accessToken;
}

let refreshTimer = null;
function scheduleRefresh(expiresInSec) {
  // refresh a bit early (e.g., 5 minutes before)
  const early = Math.max(60, expiresInSec - 300);
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      console.log('🔄 Refreshing Twitch access token…');
      const newToken = await exchangeRefreshToken();

      // Hot-swap credentials and reconnect
      client.opts.identity.password = `oauth:${newToken}`;
      await client.disconnect();
      await client.connect();
      console.log('✅ Reconnected with fresh token');
    } catch (err) {
      console.error('❌ Token refresh error:', err);
      // Backoff retry after 60s
      refreshTimer = setTimeout(scheduleRefresh, 60_000, 600);
    }
  }, early * 1000);
}

// ---- boot and listen to messages ----
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const clean = sanitizeInput(message.trim());
  const parsed = parseCommand(clean);
  if (!parsed) return;

  const def = registry.get(parsed.name);
  if (!def) return; // unknown: ignore or reply if you want

  // mod-only?
  if (def.modOnly && !isModOrBroadcaster(tags)) {
    return; // or: await safeSay(client, channel, 'Mods only.');
  }

  // per-user per-command cooldown
  const waitMs = onCooldown(parsed.name, tags['user-id'] ?? tags.username, def.cooldownMs);
  if (waitMs > 0) return; // silent; avoids spam

  try {
    await def.exec({
      client,
      channel,
      tags,
      args: parsed.args,
      rawArgs: parsed.rawArgs,
      registry, // pass registry for help command
    });
  } catch (err) {
    console.error(`command ${parsed.name} error:`, err);
    await safeSay(client, channel, `Error running !${parsed.name}.`);
  }
});

// helpful logs
client.on('connected', (addr, port) => console.log('connected:', addr, port));
client.on('join', (chan, username, self) => { if (self) console.log('joined as', username); });
client.on('notice', (_ch, id, msg) => console.warn('NOTICE:', id, msg));
client.on('disconnected', r => console.warn('disconnected:', r));

(async () => {
  try {
    await client.connect();
    console.log('✅ Connected to Twitch chat');

    // kick off the first scheduled refresh using a safe default window
    // if you know the current token’s real expiry, you can use it;
    // otherwise, start a conservative cycle (e.g., 50 minutes).
    scheduleRefresh(3000); // ~50 min
  } catch (e) {
    console.error('Login/connect error:', e);
  }
})();

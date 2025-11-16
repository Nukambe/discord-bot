import tmi from 'tmi.js';
import { request } from 'undici';
import { loadCommands } from './lib/commandLoader.js';
import { parseCommand, isModOrBroadcaster, safeSay } from './lib/utils.js';
import { onCooldown } from './lib/cooldown.js';
import { persistRefreshToHeroku } from './lib/persistRefreshToken.js';
import { sanitizeInput } from '../../util/sanitize.js';
import 'dotenv/config';

// --- load commands from ./commands ---
const registry = await loadCommands(); // Map<name|alias, def>

// --- token & client config ---
let accessToken = process.env.TWITCH_OAUTH_TOKEN?.replace(/^oauth:/, ''); // raw token (no 'oauth:')
let refreshToken = process.env.TWITCH_REFRESH;
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;

const channels = [process.env.TWITCH_CHANNEL];

// --- refresh timer state (must be defined BEFORE scheduleRefresh is ever used) ---
let refreshTimer = null;

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

// ---- token refresh helpers ----
function scheduleRefresh(expiresInSec) {
  // refresh a bit early (e.g., 5 minutes before)
  const early = Math.max(60, expiresInSec - 300);

  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

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
  }

  // schedule next refresh based on new token's TTL
  if (data.expires_in) {
    scheduleRefresh(data.expires_in);
  }

  return accessToken;
}

async function validateToken(token) {
  if (!token) return false;

  const res = await request('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${token}` },
  });

  return res.statusCode === 200;
}

// --- client instance (will be assigned after validation/refresh) ---
let client;

// ---- bootstrap: validate token, maybe refresh, then create client ----
{
  let isValid = false;

  try {
    isValid = await validateToken(accessToken);
  } catch (err) {
    console.error('Error validating access token:', err);
  }

  if (!isValid) {
    console.log('❗ Access token invalid, refreshing...');
    try {
      accessToken = await exchangeRefreshToken();
      console.log('✅ Got new access token on startup');
    } catch (err) {
      console.error('❌ Failed to refresh token on startup:', err);
      // At this point, client.connect() will likely fail, but we log clearly.
    }
  }

  client = makeClient(accessToken);
}

// ---- message handlers ----
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const clean = sanitizeInput(message.trim());
  const parsed = parseCommand(clean);
  if (!parsed) return;

  const def = registry.get(parsed.name);
  if (!def) return; // unknown command

  // mod-only?
  if (def.modOnly && !isModOrBroadcaster(tags)) {
    return; // or: await safeSay(client, channel, 'Mods only.');
  }

  // per-user per-command cooldown
  const waitMs = onCooldown(
    parsed.name,
    tags['user-id'] ?? tags.username,
    def.cooldownMs
  );
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
client.on('join', (chan, username, self) => {
  if (self) console.log('joined as', username);
});
client.on('notice', (_ch, id, msg) => console.warn('NOTICE:', id, msg));
client.on('disconnected', r => console.warn('disconnected:', r));

// ---- connect and start refresh cycle ----
(async () => {
  try {
    await client.connect();
    console.log('✅ Connected to Twitch chat');

    // Kick off a conservative refresh cycle if we haven't already scheduled one
    // (exchangeRefreshToken will also schedule with real expires_in).
    scheduleRefresh(3000); // ~50 minutes
  } catch (e) {
    console.error('Login/connect error:', e);
  }
})();

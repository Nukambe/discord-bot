import 'dotenv/config';
import tmi from 'tmi.js';
import { request } from 'undici';
import { loadCommands } from './lib/commandLoader.js';
import { parseCommand, isModOrBroadcaster, safeSay } from './lib/utils.js';
import { onCooldown } from './lib/cooldown.js';
import { persistRefreshToHeroku } from './lib/persistRefreshToken.js';
import { startOverlay } from './lib/overlayProcess.js';
import { launchOverlayWindow } from './lib/launchOverlayWindow.js';
import { startSpotify } from './lib/spotify.js';
import { sanitizeInput } from '../../util/sanitize.js';

// --- load commands from ./commands ---
const registry = await loadCommands(); // Map<name|alias, def>

// --- overlay (React app served by its own Vite server, OBS-capturable window), started before Twitch connects ---
const OVERLAY_PORT = Number(process.env.OVERLAY_PORT) || 5183;
let overlay = null;

try {
  overlay = await startOverlay({ port: OVERLAY_PORT });
  console.log(`🖥️  Overlay running at ${overlay.url}`);
  launchOverlayWindow(overlay.url);
} catch (err) {
  console.error('❌ Failed to start overlay:', err);
}

// --- Spotify "Now Playing" panel, optional (skips itself if unconfigured) ---
if (overlay) {
  try {
    await startSpotify(overlay);
  } catch (err) {
    console.error('❌ Spotify integration failed to start:', err);
  }
}

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

// ---- overlay "Chat" panel: rolling window of chat, pushed as full state ----
const CHAT_HISTORY_LIMIT = 50;
let chatHistory = [];
function pushChat(entry) {
  chatHistory = [...chatHistory, entry].slice(-CHAT_HISTORY_LIMIT);
  overlay?.push('chat', chatHistory);
}
function removeChatByMsgId(msgId) {
  chatHistory = chatHistory.filter(entry => entry.id !== msgId);
  overlay?.push('chat', chatHistory);
}
function removeChatByUsername(username) {
  chatHistory = chatHistory.filter(entry => entry.username !== username);
  overlay?.push('chat', chatHistory);
}

// ---- overlay "Recent" panel: last command run + its response ----
// tmi.js echoes the bot's own outgoing messages back through 'message' with
// self=true, so we correlate that to whichever command we most recently ran.
let lastCommand = null;
const RECENT_CORRELATION_WINDOW_MS = 5000;

// ---- message handlers ----
client.on('message', async (channel, tags, message, self) => {
  const displayName = tags['display-name'] || tags.username;

  if (self) {
    pushChat({ id: tags.id, username: tags.username, user: displayName, message, at: Date.now(), self: true });
    if (lastCommand && Date.now() - lastCommand.at < RECENT_CORRELATION_WINDOW_MS) {
      overlay?.push('recent', {
        command: lastCommand.name,
        requestedBy: lastCommand.requestedBy,
        response: message,
        at: Date.now(),
      });
    }
    return;
  }

  pushChat({
    id: tags.id,
    username: tags.username,
    user: displayName,
    message,
    at: Date.now(),
    color: tags.color,
    emotes: tags.emotes,
  });

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

  lastCommand = { name: parsed.name, requestedBy: displayName, at: Date.now() };

  try {
    await def.exec({
      client,
      channel,
      tags,
      args: parsed.args,
      rawArgs: parsed.rawArgs,
      registry, // pass registry for help command
      overlay, // pass overlay so commands can push events/state to the React window
    });
  } catch (err) {
    console.error(`command ${parsed.name} error:`, err);
    await safeSay(client, channel, `Error running !${parsed.name}.`);
  }
});

// helpful logs
client.on('connected', (addr, port) => {
  console.log('connected:', addr, port);
  overlay?.push('status', { twitchConnected: true, channel: channels[0] });
});
client.on('join', (chan, username, self) => {
  if (self) console.log('joined as', username);
});
client.on('notice', (_ch, id, msg) => console.warn('NOTICE:', id, msg));
client.on('disconnected', r => {
  console.warn('disconnected:', r);
  overlay?.push('status', { twitchConnected: false });
});

// mod actions: mirror Twitch chat's own behavior — removed/deleted messages disappear from the overlay too
client.on('messagedeleted', (channel, username, deletedMessage, userstate) => {
  removeChatByMsgId(userstate['target-msg-id']);
});
client.on('ban', (channel, username) => {
  removeChatByUsername(username);
});
client.on('timeout', (channel, username) => {
  removeChatByUsername(username);
});
client.on('clearchat', () => {
  chatHistory = [];
  overlay?.push('chat', chatHistory);
});

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

import WebSocket from 'ws';
import { request } from 'undici';

const CHANNELS = ['nukambe', 'bodhifide', 'valioa'];
const NOTIFY_CHANNEL_ID = '1468093888643203243';
const STATE_CHANNEL_ID = '1493671213736919280';
const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';

// login -> Discord message ID in state channel (persists across reconnects)
const liveState = new Map();
let stateLoaded = false;

// --- Twitch API helpers ---

async function getAppAccessToken(clientId, clientSecret) {
  const res = await request('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }).toString(),
  });
  const data = await res.body.json();
  if (!data.access_token) throw new Error(`Twitch token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function resolveUserIds(logins, accessToken, clientId) {
  const params = logins.map(l => `login=${encodeURIComponent(l)}`).join('&');
  const res = await request(`https://api.twitch.tv/helix/users?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId },
  });
  const data = await res.body.json();
  return data.data; // [{ id, login, display_name }]
}

async function subscribeEvent(sessionId, broadcasterId, type, accessToken, clientId) {
  const res = await request('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': clientId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type,
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      transport: { method: 'websocket', session_id: sessionId },
    }),
  });
  if (res.statusCode !== 202) {
    const body = await res.body.text();
    console.error(`EventSub subscribe(${type}) failed for ${broadcasterId} (${res.statusCode}): ${body}`);
  }
}

// --- State channel helpers ---

async function getStateChannel(discordClient) {
  return discordClient.channels.cache.get(STATE_CHANNEL_ID)
    ?? await discordClient.channels.fetch(STATE_CHANNEL_ID).catch(() => null);
}

async function getNotifyChannel(discordClient) {
  return discordClient.channels.cache.get(NOTIFY_CHANNEL_ID)
    ?? await discordClient.channels.fetch(NOTIFY_CHANNEL_ID).catch(() => null);
}

// Populate liveState from the state channel on first startup.
async function loadState(discordClient) {
  if (stateLoaded) return;
  stateLoaded = true;

  const ch = await getStateChannel(discordClient);
  if (!ch) return;

  const messages = await ch.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return;

  for (const [msgId, msg] of messages) {
    const login = msg.content.trim().toLowerCase();
    if (CHANNELS.includes(login)) liveState.set(login, msgId);
  }

  console.log(`EventSub state loaded: ${[...liveState.keys()].join(', ') || 'none live'}`);
}

// Returns true if this is a new live transition (not already tracked).
async function markLive(discordClient, login) {
  if (liveState.has(login)) return false;
  const ch = await getStateChannel(discordClient);
  if (ch) {
    const msg = await ch.send(login).catch(() => null);
    if (msg) liveState.set(login, msg.id);
  }
  return true;
}

async function markOffline(discordClient, login) {
  const msgId = liveState.get(login);
  if (!msgId) return;
  liveState.delete(login);
  const ch = await getStateChannel(discordClient);
  await ch?.messages.delete(msgId).catch(() => null);
}

// --- Startup live check ---

async function checkCurrentlyLive(discordClient, userMap, accessToken, clientId) {
  const ids = [...userMap.keys()].map(id => `user_id=${encodeURIComponent(id)}`).join('&');
  const res = await request(`https://api.twitch.tv/helix/streams?${ids}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId },
  });
  const data = await res.body.json();

  const notifyCh = await getNotifyChannel(discordClient);

  for (const stream of data.data ?? []) {
    const isNew = await markLive(discordClient, stream.user_login);
    if (isNew && notifyCh) {
      notifyCh.send(`**${stream.user_name}** is live on Twitch! https://twitch.tv/${stream.user_login}`);
    }
  }
}

// --- Main ---

export function startStreamNotifier(discordClient) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;

  let keepaliveTimer;
  let keepaliveTimeoutSec = 10;

  function resetKeepalive(ws) {
    clearTimeout(keepaliveTimer);
    keepaliveTimer = setTimeout(() => {
      console.warn('EventSub keepalive timeout — reconnecting');
      ws.terminate();
    }, (keepaliveTimeoutSec + 10) * 1000);
  }

  async function connect(url = EVENTSUB_WS_URL) {
    let accessToken;
    let userMap;

    try {
      accessToken = await getAppAccessToken(clientId, clientSecret);
      const users = await resolveUserIds(CHANNELS, accessToken, clientId);
      userMap = new Map(users.map(u => [u.id, u.display_name]));
    } catch (err) {
      console.error('EventSub setup error:', err);
      setTimeout(() => connect(), 15_000);
      return;
    }

    const ws = new WebSocket(url);

    ws.on('open', () => console.log('EventSub WebSocket connected'));

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      const type = msg.metadata?.message_type;
      resetKeepalive(ws);

      if (type === 'session_welcome') {
        const { id: sessionId, keepalive_timeout_seconds } = msg.payload.session;
        keepaliveTimeoutSec = keepalive_timeout_seconds ?? 10;
        resetKeepalive(ws);

        for (const [id] of userMap) {
          await subscribeEvent(sessionId, id, 'stream.online', accessToken, clientId);
          await subscribeEvent(sessionId, id, 'stream.offline', accessToken, clientId);
        }
        console.log(`EventSub subscribed for: ${CHANNELS.join(', ')}`);

        await loadState(discordClient);
        await checkCurrentlyLive(discordClient, userMap, accessToken, clientId);

      } else if (type === 'notification') {
        const { subscription, event } = msg.payload;
        const login = event.broadcaster_user_login;

        if (subscription.type === 'stream.online') {
          const displayName = userMap.get(event.broadcaster_user_id) ?? event.broadcaster_user_login;
          const isNew = await markLive(discordClient, login);
          if (isNew) {
            const notifyCh = await getNotifyChannel(discordClient);
            notifyCh?.send(`**${displayName}** is live on Twitch! https://twitch.tv/${login}`);
          }
        } else if (subscription.type === 'stream.offline') {
          await markOffline(discordClient, login);
        }

      } else if (type === 'session_reconnect') {
        const reconnectUrl = msg.payload.session.reconnect_url;
        const old = ws;
        await connect(reconnectUrl);
        old.close(1000);
      }
    });

    ws.on('close', (code) => {
      clearTimeout(keepaliveTimer);
      if (code !== 1000) {
        console.warn(`EventSub WebSocket closed (${code}), reconnecting in 5s`);
        setTimeout(() => connect(), 5_000);
      }
    });

    ws.on('error', (err) => console.error('EventSub WS error:', err));
  }

  connect();
}

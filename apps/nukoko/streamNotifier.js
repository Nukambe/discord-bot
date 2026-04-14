import { request } from 'undici';

const CHANNELS = ['nukambe', 'bodhifide', 'valioa'];
const NOTIFY_CHANNEL_ID = '1468093888643203243';
const STATE_CHANNEL_ID = '1493671213736919280';
const POLL_INTERVAL_MS = 60_000;

// login -> Discord message ID in state channel
const liveState = new Map();
let stateLoaded = false;

// --- Twitch API ---

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
  return { token: data.access_token, expiresIn: data.expires_in ?? 3600 };
}

async function fetchLiveStreams(logins, accessToken, clientId) {
  const params = logins.map(l => `user_login=${encodeURIComponent(l)}`).join('&');
  const res = await request(`https://api.twitch.tv/helix/streams?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId },
  });
  const data = await res.body.json();
  return data.data ?? []; // [{ user_login, user_name, ... }]
}

// --- State channel ---

async function loadState(discordClient) {
  if (stateLoaded) return;
  stateLoaded = true;
  const ch = await fetchChannel(discordClient, STATE_CHANNEL_ID);
  if (!ch) return;
  const messages = await ch.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return;
  for (const [msgId, msg] of messages) {
    const login = msg.content.trim().toLowerCase();
    if (CHANNELS.includes(login)) liveState.set(login, msgId);
  }
  console.log(`Stream state loaded: ${[...liveState.keys()].join(', ') || 'none live'}`);
}

async function markLive(discordClient, login) {
  if (liveState.has(login)) return false;
  const ch = await fetchChannel(discordClient, STATE_CHANNEL_ID);
  const msg = await ch?.send(login).catch(() => null);
  if (msg) liveState.set(login, msg.id);
  return true;
}

async function markOffline(discordClient, login) {
  const msgId = liveState.get(login);
  if (!msgId) return;
  liveState.delete(login);
  const ch = await fetchChannel(discordClient, STATE_CHANNEL_ID);
  await ch?.messages.delete(msgId).catch(() => null);
}

async function fetchChannel(discordClient, id) {
  return discordClient.channels.cache.get(id)
    ?? await discordClient.channels.fetch(id).catch(() => null);
}

// --- Poll ---

async function poll(discordClient, accessToken, clientId) {
  const streams = await fetchLiveStreams(CHANNELS, accessToken, clientId);
  const nowLive = new Set(streams.map(s => s.user_login));

  // went live
  for (const stream of streams) {
    const isNew = await markLive(discordClient, stream.user_login);
    if (isNew) {
      const ch = await fetchChannel(discordClient, NOTIFY_CHANNEL_ID);
      ch?.send(`**${stream.user_name}** is live on Twitch! https://twitch.tv/${stream.user_login}`);
    }
  }

  // went offline
  for (const login of [...liveState.keys()]) {
    if (!nowLive.has(login)) await markOffline(discordClient, login);
  }
}

// --- Main ---

export async function startStreamNotifier(discordClient) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;

  let accessToken;

  async function refreshToken() {
    const result = await getAppAccessToken(clientId, clientSecret);
    accessToken = result.token;
    // Refresh a bit before expiry
    setTimeout(refreshToken, (result.expiresIn - 300) * 1000);
  }

  await refreshToken();
  await loadState(discordClient);

  // Run immediately, then on interval
  await poll(discordClient, accessToken, clientId).catch(console.error);
  setInterval(() => poll(discordClient, accessToken, clientId).catch(console.error), POLL_INTERVAL_MS);

  console.log(`Stream notifier polling every ${POLL_INTERVAL_MS / 1000}s for: ${CHANNELS.join(', ')}`);
}

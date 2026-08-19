import { request } from 'undici';

const CHANNELS = ['nukambe', 'bodhifide', 'valioa', 'woosah2sickwitit'];
const NOTIFY_CHANNEL_ID = '1468093888643203243';
const STATE_CHANNEL_ID = '1493671213736919280';
const POLL_INTERVAL_MS = 60_000;
// Helix /streams intermittently returns nothing for a stream that is still up
// (ad breaks, transcode hiccups). Require several consecutive misses before
// declaring the stream over, otherwise the notify message gets torn down and
// reposted as a brand new one a minute later.
const OFFLINE_GRACE_POLLS = 3;
// Twitch only regenerates the preview JPEG every ~5min, and changing the image
// URL forces Discord to re-proxy it — which visibly blanks and repaints the
// embed. Bucket the cache-buster so the URL is stable between regenerations.
const THUMB_REFRESH_MS = 5 * 60_000;
const LIVE_COLOR = 0x9146ff; // Twitch purple
const ENDED_COLOR = 0x4f545c; // grey

// login -> { stateMsgId, notifyMsgId, peak, stream, misses, thumbBucket }
const liveState = new Map();
let stateLoaded = false;
let polling = false;

// login -> profile_image_url (fetched once at startup)
const avatars = new Map();

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
  return data.data ?? []; // [{ user_login, user_name, title, game_name, viewer_count, thumbnail_url, started_at, ... }]
}

async function fetchUserAvatars(logins, accessToken, clientId) {
  const params = logins.map(l => `login=${encodeURIComponent(l)}`).join('&');
  const res = await request(`https://api.twitch.tv/helix/users?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId },
  });
  const data = await res.body.json();
  for (const user of data.data ?? []) avatars.set(user.login, user.profile_image_url);
}

// --- Embeds ---

function thumbBucket() {
  return Math.floor(Date.now() / THUMB_REFRESH_MS);
}

function buildLiveEmbed(stream) {
  const startedAtSec = Math.floor(new Date(stream.started_at).getTime() / 1000);
  const thumb = stream.thumbnail_url.replace('{width}', '440').replace('{height}', '248');
  return {
    color: LIVE_COLOR,
    author: {
      name: `${stream.user_name} is live!`,
      url: `https://twitch.tv/${stream.user_login}`,
      icon_url: avatars.get(stream.user_login),
    },
    title: stream.title || 'Untitled stream',
    url: `https://twitch.tv/${stream.user_login}`,
    fields: [
      { name: 'Category', value: stream.game_name || '—', inline: true },
      { name: 'Viewers', value: String(stream.viewer_count), inline: true },
      { name: 'Live', value: `<t:${startedAtSec}:R>`, inline: true },
    ],
    // Cache-buster: Discord caches embed images by URL, so the preview would never refresh
    image: { url: `${thumb}?t=${thumbBucket()}` },
  };
}

function formatDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function buildEndedEmbed(login, entry, notifyMsg) {
  const stream = entry.stream;
  const name = stream?.user_name ?? login;
  const startedMs = stream ? new Date(stream.started_at).getTime() : notifyMsg.createdTimestamp;
  const fields = [{ name: 'Streamed for', value: formatDuration(Date.now() - startedMs), inline: true }];
  if (entry.peak) fields.push({ name: 'Peak viewers', value: String(entry.peak), inline: true });
  return {
    color: ENDED_COLOR,
    author: {
      name: `${name} was live`,
      url: `https://twitch.tv/${login}`,
      icon_url: avatars.get(login),
    },
    title: stream?.title || 'Stream ended',
    url: `https://twitch.tv/${login}`,
    fields,
  };
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
    // "login notifyMsgId" (older messages may be just "login")
    const [login, notifyMsgId] = msg.content.trim().split(/\s+/);
    const key = login?.toLowerCase();
    if (CHANNELS.includes(key)) liveState.set(key, { stateMsgId: msgId, notifyMsgId, peak: 0 });
  }
  console.log(`Stream state loaded: ${[...liveState.keys()].join(', ') || 'none live'}`);
}

async function markLive(discordClient, stream) {
  const login = stream.user_login;
  const notifyCh = await fetchChannel(discordClient, NOTIFY_CHANNEL_ID);
  const notifyMsg = await notifyCh?.send({
    content: `**${stream.user_name}** is live on Twitch! https://twitch.tv/${login}`,
    embeds: [buildLiveEmbed(stream)],
  }).catch(() => null);
  const stateCh = await fetchChannel(discordClient, STATE_CHANNEL_ID);
  const stateMsg = await stateCh?.send(`${login} ${notifyMsg?.id ?? ''}`.trim()).catch(() => null);
  liveState.set(login, {
    stateMsgId: stateMsg?.id,
    notifyMsgId: notifyMsg?.id,
    peak: stream.viewer_count,
    stream,
  });
}

async function updateLive(discordClient, stream) {
  const entry = liveState.get(stream.user_login);
  if (!entry) return;
  entry.peak = Math.max(entry.peak ?? 0, stream.viewer_count);
  const prev = entry.stream;
  entry.stream = stream;
  if (!entry.notifyMsgId) return;

  // Don't edit unless something visible actually changed — a no-op edit still
  // makes every client repaint the embed.
  const bucket = thumbBucket();
  const unchanged = prev
    && prev.title === stream.title
    && prev.game_name === stream.game_name
    && prev.viewer_count === stream.viewer_count
    && entry.thumbBucket === bucket;
  if (unchanged) return;
  entry.thumbBucket = bucket;

  const ch = await fetchChannel(discordClient, NOTIFY_CHANNEL_ID);
  const msg = await ch?.messages.fetch(entry.notifyMsgId).catch(() => null);
  await msg?.edit({ embeds: [buildLiveEmbed(stream)] }).catch(() => null);
}

async function markOffline(discordClient, login) {
  const entry = liveState.get(login);
  if (!entry) return;
  liveState.delete(login);
  const stateCh = await fetchChannel(discordClient, STATE_CHANNEL_ID);
  if (entry.stateMsgId) await stateCh?.messages.delete(entry.stateMsgId).catch(() => null);
  if (!entry.notifyMsgId) return;
  const notifyCh = await fetchChannel(discordClient, NOTIFY_CHANNEL_ID);
  const msg = await notifyCh?.messages.fetch(entry.notifyMsgId).catch(() => null);
  if (!msg) return;
  const name = entry.stream?.user_name ?? login;
  await msg.edit({
    content: `**${name}** was live on Twitch. https://twitch.tv/${login}`,
    embeds: [buildEndedEmbed(login, entry, msg)],
  }).catch(() => null);
}

async function fetchChannel(discordClient, id) {
  return discordClient.channels.cache.get(id)
    ?? await discordClient.channels.fetch(id).catch(() => null);
}

// --- Poll ---

async function poll(discordClient, accessToken, clientId) {
  // A slow poll must not overlap the next one: markLive only records the entry
  // after its awaits, so two in-flight polls would both post a go-live message.
  if (polling) return;
  polling = true;
  try {
    const streams = await fetchLiveStreams(CHANNELS, accessToken, clientId);
    const nowLive = new Set(streams.map(s => s.user_login));

    // went live / still live
    for (const stream of streams) {
      if (liveState.has(stream.user_login)) await updateLive(discordClient, stream);
      else await markLive(discordClient, stream);
    }

    // went offline (only after OFFLINE_GRACE_POLLS consecutive misses)
    for (const [login, entry] of [...liveState]) {
      if (nowLive.has(login)) {
        entry.misses = 0;
        continue;
      }
      entry.misses = (entry.misses ?? 0) + 1;
      if (entry.misses >= OFFLINE_GRACE_POLLS) await markOffline(discordClient, login);
    }
  } finally {
    polling = false;
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
    // Refresh daily (token lasts ~57 days but setTimeout has a 32-bit ms limit)
    setTimeout(refreshToken, 24 * 60 * 60 * 1000);
  }

  await refreshToken();
  await fetchUserAvatars(CHANNELS, accessToken, clientId).catch(console.error);
  await loadState(discordClient);

  // Run immediately, then on interval
  await poll(discordClient, accessToken, clientId).catch(console.error);
  setInterval(() => poll(discordClient, accessToken, clientId).catch(console.error), POLL_INTERVAL_MS);

  console.log(`Stream notifier polling every ${POLL_INTERVAL_MS / 1000}s for: ${CHANNELS.join(', ')}`);
}

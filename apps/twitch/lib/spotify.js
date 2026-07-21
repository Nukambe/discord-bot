import { request } from 'undici';
import { updateEnvVar } from './envFile.js';

// Read lazily (not as module-level consts) so this module doesn't depend on
// import order relative to `dotenv/config` in whatever imports it.
function getClientId() { return process.env.SPOTIFY_CLIENT_ID; }
function getClientSecret() { return process.env.SPOTIFY_CLIENT_SECRET; }

let refreshToken = process.env.SPOTIFY_REFRESH;
let accessToken = null;
let refreshTimer = null;

const POLL_MS = 7000;

function isConfigured() {
  return Boolean(getClientId() && getClientSecret() && refreshToken);
}

function scheduleRefresh(expiresInSec) {
  const early = Math.max(60, expiresInSec - 300);
  console.log(`🎵 Spotify: next token refresh in ${early}s`);

  if (refreshTimer) clearTimeout(refreshTimer);

  refreshTimer = setTimeout(async () => {
    try {
      await exchangeRefreshToken();
    } catch (err) {
      console.error('❌ Spotify token refresh error:', err.message || err);
      refreshTimer = setTimeout(scheduleRefresh, 60_000, 600);
    }
  }, early * 1000);
}

async function exchangeRefreshToken() {
  console.log('🎵 Spotify: exchanging refresh token for an access token…');

  const basic = Buffer.from(`${getClientId()}:${getClientSecret()}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }).toString();

  const res = await request('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  if (res.statusCode !== 200) {
    const text = await res.body.text();
    console.error(`❌ Spotify refresh failed (${res.statusCode}): ${text}`);
    throw new Error(`Spotify refresh failed (${res.statusCode}): ${text}`);
  }

  const data = await res.body.json();
  accessToken = data.access_token;
  console.log('🎵 Spotify: access token acquired, expires in', data.expires_in, 's');

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    // Spotify may rotate it; persist locally since there's no third-party
    // deploy target for this local-only app (unlike the Twitch/Heroku flow).
    console.log('🎵 Spotify: refresh token rotated, updating .env');
    refreshToken = data.refresh_token;
    process.env.SPOTIFY_REFRESH = refreshToken;
    updateEnvVar('SPOTIFY_REFRESH', refreshToken);
  }

  if (data.expires_in) {
    scheduleRefresh(data.expires_in);
  }

  return accessToken;
}

async function getCurrentlyPlaying() {
  const res = await request('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.statusCode === 204) return { playing: false };
  if (res.statusCode === 401) throw new Error('UNAUTHORIZED');
  if (res.statusCode === 429) {
    console.warn('🎵 Spotify: rate limited, skipping this poll');
    return null;
  }
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`Spotify currently-playing failed (${res.statusCode}): ${text}`);
  }

  const data = await res.body.json();
  if (!data?.item) return { playing: false };

  return {
    playing: true,
    isPlaying: data.is_playing,
    title: data.item.name,
    artists: (data.item.artists ?? []).map(a => a.name),
    album: data.item.album?.name ?? null,
    artworkUrl: data.item.album?.images?.[0]?.url ?? null,
    progressMs: data.progress_ms ?? 0,
    durationMs: data.item.duration_ms ?? 0,
  };
}

function startPolling(overlay) {
  console.log(`🎵 Spotify: polling every ${POLL_MS}ms`);

  (async function tick() {
    try {
      const result = await getCurrentlyPlaying();
      if (result) {
        console.log(
          result.playing
            ? `🎵 Spotify: now playing "${result.title}" — ${result.artists.join(', ')}`
            : '🎵 Spotify: nothing playing'
        );
        overlay.push('now-playing', { ...result, fetchedAt: Date.now() });
      }
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        console.warn('🎵 Spotify: access token expired mid-poll, re-authenticating…');
        try {
          await exchangeRefreshToken();
        } catch (e) {
          console.error('❌ Spotify re-auth failed:', e.message || e);
        }
      } else {
        console.error('❌ Spotify poll error:', err.message || err);
      }
    } finally {
      setTimeout(tick, POLL_MS);
    }
  })();
}

export async function startSpotify(overlay) {
  const hasClientId = Boolean(getClientId());
  const hasClientSecret = Boolean(getClientSecret());
  const hasRefreshToken = Boolean(refreshToken);

  if (!isConfigured()) {
    console.log(
      `🎵 Spotify not configured — skipping Now Playing panel ` +
      `(SPOTIFY_CLIENT_ID: ${hasClientId ? 'set' : 'MISSING'}, ` +
      `SPOTIFY_CLIENT_SECRET: ${hasClientSecret ? 'set' : 'MISSING'}, ` +
      `SPOTIFY_REFRESH: ${hasRefreshToken ? 'set' : 'MISSING'})`
    );
    return;
  }

  console.log('🎵 Spotify: starting…');
  await exchangeRefreshToken();
  startPolling(overlay);
  console.log('🎵 Spotify Now Playing polling started');
}

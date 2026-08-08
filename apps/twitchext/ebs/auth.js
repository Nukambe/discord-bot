import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/**
 * Twitch extension JWT handling.
 *
 * Every viewer request carries a JWT that Twitch minted and signed with the
 * extension's shared secret. Verifying it is what stops someone from asking the
 * EBS for an arbitrary streamer's game state — the channel id comes out of the
 * *token*, never out of the query string.
 *
 * Implemented directly on node:crypto rather than pulling in a JWT library: the
 * only algorithm Twitch uses here is HS256, and this is ~40 lines.
 */

/** Twitch hands you the secret base64-encoded; it must be decoded before use. */
export function decodeSecret(base64Secret) {
  const buf = Buffer.from(base64Secret, 'base64');
  if (!buf.length) throw new Error('TWITCHEXT_SECRET is empty or not valid base64');
  return buf;
}

export function verifyViewerToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');

  const [headerB64, payloadB64, signatureB64] = parts;

  const header = jsonFromB64Url(headerB64);
  if (header.alg !== 'HS256') throw new Error(`unexpected JWT alg "${header.alg}"`);

  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const actual = Buffer.from(signatureB64, 'base64url');

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('JWT signature does not verify');
  }

  const payload = jsonFromB64Url(payloadB64);

  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
    throw new Error('JWT expired');
  }
  if (!payload.channel_id) throw new Error('JWT has no channel_id');

  return {
    channelId: String(payload.channel_id),
    role: payload.role || 'external',
    // Opaque id is stable per viewer per channel without identifying them.
    opaqueUserId: payload.opaque_user_id || null,
    userId: payload.user_id || null,
  };
}

/**
 * Mints the token the EBS needs to call Twitch's PubSub endpoint. Twitch
 * requires role "external" plus explicit pubsub permissions.
 */
export function signBroadcastToken({ secret, ownerId, channelId, ttlSeconds = 60 }) {
  const header = b64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64Url(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      user_id: String(ownerId),
      role: 'external',
      channel_id: String(channelId),
      pubsub_perms: { send: ['broadcast'] },
    })
  );

  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Constant-time compare for the companion's shared secret. */
export function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so length isn't leaked by timing.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function generateSecret() {
  return randomBytes(32).toString('hex');
}

function jsonFromB64Url(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function b64Url(str) {
  return Buffer.from(str).toString('base64url');
}

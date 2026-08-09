import 'dotenv/config';
import { createEbs } from './server.js';

/**
 * EBS entry point. Heroku-shaped: binds process.env.PORT, logs to stdout, holds
 * no state worth persisting.
 */

const secret = process.env.TWITCHEXT_SECRET;
const companionSecret = process.env.TWITCHEXT_COMPANION_SECRET;
const clientId = process.env.TWITCHEXT_CLIENT_ID;
const ownerId = process.env.TWITCHEXT_OWNER_ID;

if (!secret) throw new Error('Missing TWITCHEXT_SECRET (base64 secret from the extension console)');
if (!companionSecret) throw new Error('Missing TWITCHEXT_COMPANION_SECRET');

// The extension frontend is served from <client-id>.ext-twitch.tv. The Twitch
// developer rig serves from localhost, and since this EBS is designed to run on
// the streamer's own machine that origin is allowed by default — set
// TWITCHEXT_ALLOW_LOCAL=false to lock it down if the EBS is ever exposed.
const allowLocal = process.env.TWITCHEXT_ALLOW_LOCAL !== 'false';
const allowedOrigins = [
  clientId ? `https://${clientId}.ext-twitch.tv` : null,
  '*.ext-twitch.tv',
  ...(allowLocal
    ? ['http://localhost:8080', 'https://localhost:8080', 'http://localhost:8081', 'https://localhost:8081']
    : []),
].filter(Boolean);

const { server, pubsub } = await createEbs({
  secret,
  companionSecret,
  clientId,
  ownerId,
  allowedOrigins,
  pubsubEnabled: process.env.TWITCHEXT_PUBSUB !== 'false',
});

const port = Number(process.env.PORT) || Number(process.env.TWITCHEXT_PORT) || 8080;

// Loopback by default: this runs on the streamer's PC, not a public host, and
// binding 0.0.0.0 would expose game state to anything on the local network.
const host = process.env.TWITCHEXT_HOST || '127.0.0.1';

server.listen(port, host, () => {
  console.log(`🧩 twitchext EBS listening on http://${host}:${port}`);
  console.log(`   pubsub ${pubsub.enabled ? 'enabled' : 'disabled (poll-only)'}`);
  console.log(`   allowed origins: ${allowedOrigins.join(', ')}`);
  if (!ownerId) console.warn('   ⚠️  TWITCHEXT_OWNER_ID unset — PubSub broadcasts will be skipped');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n👋 ${signal} — closing EBS`);
    server.close(() => process.exit(0));
  });
}

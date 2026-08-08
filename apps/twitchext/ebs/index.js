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

// The extension frontend is always served from <client-id>.ext-twitch.tv. The
// rig origin is only allowed when explicitly opted in, so a production deploy
// isn't reachable from a random developer's machine.
const allowedOrigins = [
  clientId ? `https://${clientId}.ext-twitch.tv` : null,
  '*.ext-twitch.tv',
  ...(process.env.TWITCHEXT_ALLOW_LOCAL === 'true' ? ['http://localhost:8080', 'https://localhost:8080'] : []),
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

server.listen(port, () => {
  console.log(`🧩 twitchext EBS listening on :${port}`);
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

import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { resolveTodaysUrl, fetchMonopolyGoHtml } from '../services/monopolygoService.js';
import { formatMonopolyGoForDiscord } from '../services/monopolygoFormatService.js';

function getOverrideDateFromArgv() {
  const arg = process.argv.find(a => a.startsWith('--date='));
  if (!arg) return null;
  const iso = arg.split('=')[1]?.trim();
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid --date: ${iso}`);
  return d;
}

async function main() {
  const date = getOverrideDateFromArgv() ?? new Date();
  const url = await resolveTodaysUrl(date);       // 👈 use the resolver
  console.log('[daily] URL:', url);

  const html = await fetchMonopolyGoHtml(url);    // you can pass url explicitly
  const payload = formatMonopolyGoForDiscord(html, { sourceUrl: url });

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.BOT_TOKEN);

  // v15-safe: wait for clientReady instead of "ready"
  await new Promise(res => client.once(Events.ClientReady, res));

  const channel = await client.channels.fetch(process.env.CHANNEL_ID);
  await channel.send(payload);
  client.destroy();
}

main().catch(e => {
  console.error('[daily] Error:', e.stack || e.message || e);
  process.exit(1);
});

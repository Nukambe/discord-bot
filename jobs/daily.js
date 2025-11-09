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

function nyDateLabel(d) {
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'short', day: '2-digit' });
}

async function main() {
  // Default to tomorrow (unless --date= is supplied)
  const baseDate = getOverrideDateFromArgv() ?? (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  })();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.BOT_TOKEN);
  await new Promise(res => client.once(Events.ClientReady, res));
  const channel = await client.channels.fetch(process.env.CHANNEL_ID);

  try {
    const url = await resolveTodaysUrl(baseDate);
    console.log("url", url);
    if (!url) {
      await channel.send(`Heads up: I couldn’t find a Monopoly GO! Wiki page for **${nyDateLabel(baseDate)}** yet. It may not be published. Here is a link to all events: https://monopolygo.wiki/tag/events/`);
      client.destroy();
      return;
    }

    console.log('[daily] URL:', url);
    const html = await fetchMonopolyGoHtml(url);
    const payload = formatMonopolyGoForDiscord(html, { sourceUrl: url });
    await channel.send(payload);
  } catch (err) {
    // Resolver or fetch/format failed — still notify in Discord
    console.error('[daily] Error:', err?.stack || err);
    await channel.send(`Heads up: I couldn’t find or parse the page for **${nyDateLabel(baseDate)}**. (${err?.message || 'Unknown error'})`);
  } finally {
    client.destroy();
  }
}

main().catch(e => {
  console.error('[daily] Fatal:', e?.stack || e);
  process.exit(1);
});

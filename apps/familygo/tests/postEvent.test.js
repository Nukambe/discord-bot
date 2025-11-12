import { Client, GatewayIntentBits, Events } from "discord.js";
import { postEvent } from "../postEvent.js";
import { readFile } from "fs/promises";
import { parseMonopolyEventPage } from "../getEvent.js";
import { formatMogoDiscordMessage } from "../formatEvent.js";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

// === setup paths ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.join(__dirname, "../../../monopolygo-event_2025-11-11T19-02-35-441Z.html");

// === create Discord client ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Discord ready as ${client.user.tag}`);

  try {
    const html = await readFile(FIXTURE, "utf8");

    const data = parseMonopolyEventPage(html, { debug: false });
    const formatted = formatMogoDiscordMessage(data);

    await postEvent({
      client,
      content: formatted.content,
      embeds: formatted.embeds,
      debug: true, // route to TEST_CHANNEL_ID in dev
    });

    console.log("[test] Event posted successfully!");
  } catch (err) {
    console.error("[test] Failed:", err);
  } finally {
    // give Discord some time to flush network ops before closing
    setTimeout(() => {
      client.destroy();
      process.exit(0);
    }, 3000);
  }
});

// === login ===
client.login(process.env.DISCORD_TOKEN);

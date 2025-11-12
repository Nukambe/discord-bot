import { Client, GatewayIntentBits, Events } from "discord.js";
import { runGiftRotation } from "../giftRotation.js";
import "dotenv/config";

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
    await runGiftRotation(client, { debug: true });
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

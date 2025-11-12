import { Client, GatewayIntentBits, Events } from "discord.js";
import "dotenv/config";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once(Events.ClientReady, () => {
  console.log(`Discord ready as ${client.user.tag}`);
});

client.on(Events.MessageCreate, (m) => {
  if (m.author.bot) return;
  if (m.content === "!ping") m.reply("Pong!");
});

client.login(process.env.DISCORD_TOKEN);

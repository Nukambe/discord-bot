import tmi from "tmi.js";
import "dotenv/config";

const client = new tmi.Client({
  options: { debug: false },
  connection: { reconnect: true, secure: true },
  identity: {
    username: process.env.TWITCH_BOT_USERNAME,
    password: `oauth:${process.env.TWITCH_OAUTH_TOKEN}` // chat (IRC) token
  },
  channels: [process.env.TWITCH_CHANNEL] // e.g., "yourchannel"
});

client.on("connected", (_addr, _port) => {
  console.log("Twitch chat connected");
});

client.on("message", (channel, tags, message, self) => {
  if (self) return;
  if (message.trim() === "!ping") {
    client.say(channel, `@${tags.username} Pong!`);
  }
});

client.connect();

// graceful shutdown
const shutdown = (sig) => {
  console.log(`Received ${sig}, disconnecting...`);
  try { client.disconnect(); } catch {}
  process.exit(0);
};
["SIGTERM","SIGINT"].forEach(s => process.on(s, () => shutdown(s)));

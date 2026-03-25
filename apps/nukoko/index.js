import { Client, Collection, GatewayIntentBits, Events } from "discord.js";
import { loadCommands } from "../../util/loadCommands.js";
import { deployCommands } from "./deploy-commands.js";
import path from "node:path";
import "dotenv/config";

deployCommands();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();
const cooldowns = new Collection();

const listenForCommands = async (client) => {
  const commandsPath = path.resolve("apps/nukoko/commands");
  const { commands } = await loadCommands(commandsPath);
  for (const [name, cmd] of commands) client.commands.set(name, cmd);
  console.log("🧭 Command listener initialized");

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const name = interaction.commandName;
    const cmd = client.commands.get(name);

    if (!cmd || typeof cmd.execute !== "function") {
      return interaction.reply({
        content: "⚠️ Sorry, that command isn't available right now.",
        ephemeral: true,
      }).catch(() => {});
    }

    try {
      if (cmd.cooldown) {
        const now = Date.now();
        if (!cooldowns.has(name)) cooldowns.set(name, new Collection());
        const timestamps = cooldowns.get(name);
        const cooldownMs = cmd.cooldown * 1000;

        const last = timestamps.get(interaction.user.id) || 0;
        const expires = last + cooldownMs;

        if (now < expires) {
          const remaining = Math.ceil((expires - now) / 1000);
          return interaction.reply({
            content: `⏳ Please wait **${remaining}s** before using \`/${name}\` again.`,
            ephemeral: true,
          });
        }

        timestamps.set(interaction.user.id, now);
        setTimeout(() => {
          const t = cooldowns.get(name);
          if (t) t.delete(interaction.user.id);
        }, cooldownMs).unref?.();
      }
    } catch (e) {
      console.warn("Cooldown handling error:", e);
    }

    try {
      await cmd.execute(interaction);
    } catch (err) {
      console.error(`💥 Error executing /${name}:`, err);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "⚠️ Something went wrong while running that command.",
          ephemeral: true,
        }).catch(() => {});
      } else {
        await interaction.reply({
          content: "⚠️ Something went wrong while running that command.",
          ephemeral: true,
        }).catch(() => {});
      }
    }
  });
};

client.once(Events.ClientReady, async () => {
  console.log(`✅ Discord ready as ${client.user.tag}`);
  await listenForCommands(client);
});

const shutdown = async (sig) => {
  console.log(`Received ${sig}, logging out...`);
  try { await client.destroy(); } catch {}
  process.exit(0);
};
["SIGTERM", "SIGINT"].forEach((s) => process.on(s, () => shutdown(s)));

client.login(process.env.NUKOKO_TOKEN);

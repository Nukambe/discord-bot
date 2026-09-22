import { Client, Collection, GatewayIntentBits, Events } from "discord.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import { loadCommands } from "../../util/loadCommands.js";
import { deployCommands, COMMANDS_DIR } from "./deploy-commands.js";
import { startScheduler } from "./cronScheduler.js";
import { cronSlots } from "./schedule.js";
import { initEnv, fetchEnvChannel, onEnvChange, defaultEnv } from "./env.js";
import { runReminder, handleReminderButton, BUTTON_PREFIX } from "./jobs/reminder.js";
import { handleCronModalSubmit, MODAL_PREFIX } from "./commands/cron.js";

/**
 * chappelly — a household reminder bot. Everything it does is driven by the
 * env JSON stored in a Discord channel (env.js): each entry under env.crons
 * becomes a scheduler job that posts a reminder with a confirm button
 * (jobs/reminder.js). Edit the env from Discord with /cron (form) or /env
 * (direct edit) and the schedule rebuilds itself.
 *
 * This module exports startChappelly() so nukoko's process can host it —
 * both bots run under the single `nukoko` dyno (see Procfile) — and only
 * boots itself when run directly (`node apps/chappelly/index.js`).
 */

/**
 * Turn env.crons into scheduler jobs. Disabled crons are left out entirely;
 * a malformed one throws from slots() and the scheduler logs and skips it.
 */
const buildJobs = (env) =>
  Object.entries(env.crons ?? {})
    .filter(([, cron]) => cron && typeof cron === "object" && cron.enabled !== false)
    .map(([id, cron]) => ({
      name: id,
      slots: () => cronSlots(cron),
      run: (ctx) => runReminder(ctx, id),
    }));

const ephemeralError = async (interaction, content) => {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, ephemeral: true }).catch(() => {});
  } else {
    await interaction.reply({ content, ephemeral: true }).catch(() => {});
  }
};

const listenForCommands = async (client) => {
  const { commands } = await loadCommands(COMMANDS_DIR);
  for (const [name, cmd] of commands) client.commands.set(name, cmd);
  console.log("🧭 [chappelly] Command listener initialized");

  const cooldowns = new Collection();

  client.on(Events.InteractionCreate, async (interaction) => {
    // Autocomplete arrives as its own interaction type and has a hard 3s
    // deadline, so it bypasses the cooldown/error-reply path below.
    if (interaction.isAutocomplete()) {
      const cmd = client.commands.get(interaction.commandName);
      if (typeof cmd?.autocomplete !== "function") return;
      try {
        await cmd.autocomplete(interaction);
      } catch (err) {
        console.error(`💥 [chappelly] Autocomplete failed for /${interaction.commandName}:`, err);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (!interaction.customId.startsWith(MODAL_PREFIX)) return;
      try {
        await handleCronModalSubmit(interaction);
      } catch (err) {
        console.error("💥 [chappelly] Error handling cron modal submit:", err);
        await ephemeralError(interaction, "⚠️ Something went wrong saving that cron.");
      }
      return;
    }

    if (interaction.isButton()) {
      if (!interaction.customId.startsWith(BUTTON_PREFIX)) return;
      try {
        await handleReminderButton(interaction);
      } catch (err) {
        console.error("💥 [chappelly] Error handling reminder button:", err);
        await ephemeralError(interaction, "⚠️ Couldn't record that, try again.");
      }
      return;
    }

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
      console.warn("[chappelly] Cooldown handling error:", e);
    }

    try {
      await cmd.execute(interaction);
    } catch (err) {
      console.error(`💥 [chappelly] Error executing /${name}:`, err);
      await ephemeralError(interaction, "⚠️ Something went wrong while running that command.");
    }
  });
};

/**
 * Boot chappelly's Discord client. Returns `{ client, stop }`; `stop()` tears
 * the schedule down and logs the client out, and is what nukoko's shutdown
 * awaits when hosting this bot.
 */
export function startChappelly() {
  const token = process.env.CHAPPELLY_TOKEN;
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.commands = new Collection();

  let scheduler = null;

  client.once(Events.ClientReady, async () => {
    console.log(`✅ [chappelly] Discord ready as ${client.user.tag}`);

    let env;
    try {
      env = await initEnv(client);
      const envChannel = await fetchEnvChannel(client);
      await deployCommands({ applicationId: client.application.id, guildId: envChannel.guildId });
    } catch (err) {
      console.error("💥 [chappelly] Failed to initialize env:", err);
      env = defaultEnv();
    }

    scheduler = startScheduler(buildJobs(env), { client, env });

    // Every env write — /env set, /cron edit, anything — re-resolves the whole
    // schedule. Fire times merge and split as crons change, so the task set is
    // rebuilt wholesale rather than patched.
    onEnvChange((newEnv) => {
      console.log("🔄 [chappelly] Env updated — rebuilding cron schedule...");
      scheduler?.stop();
      scheduler = startScheduler(buildJobs(newEnv), { client, env: newEnv });
    });

    await listenForCommands(client);
  });

  if (!token) {
    console.error("💥 [chappelly] CHAPPELLY_TOKEN is not set — chappelly will not start.");
  } else {
    client.login(token).catch((err) => console.error("💥 [chappelly] Login failed:", err));
  }

  return {
    client,
    async stop() {
      scheduler?.stop();
      try { await client.destroy(); } catch {}
    },
  };
}

// Only self-boot when run directly (`node apps/chappelly/index.js`), not when
// nukoko imports this module to host the bot in its own process.
const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (runDirectly) {
  const chappelly = startChappelly();
  const shutdown = async (sig) => {
    console.log(`[chappelly] Received ${sig}, logging out...`);
    await chappelly.stop();
    process.exit(0);
  };
  ["SIGTERM", "SIGINT"].forEach((s) => process.on(s, () => shutdown(s)));
}

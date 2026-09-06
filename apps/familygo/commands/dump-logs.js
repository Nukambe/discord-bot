import { SlashCommandBuilder, AttachmentBuilder, MessageFlags } from "discord.js";
import { getLogText } from "../logBuffer.js";
import { getDb } from "../db.js";

// Deliberately hardcoded (no env var) — this is a diagnostics channel, and the
// packaged .exe runs on an end user's machine where editing .env isn't an option.
const DUMP_CHANNEL_ID = "1437862445266895001";

export default {
  data: new SlashCommandBuilder()
    .setName("dump-logs")
    .setDescription("Post the console log history and current database state to the diagnostics channel."),
  cooldown: 10,
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = await interaction.client.channels.fetch(DUMP_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased?.()) {
      return interaction.editReply(`❌ Couldn't fetch the diagnostics channel (${DUMP_CHANNEL_ID}).`);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logText = getLogText() || "(log buffer is empty)";
    const files = [
      new AttachmentBuilder(Buffer.from(logText, "utf8"), { name: `console-${stamp}.txt` }),
    ];

    // The db read can fail independently of the log capture — still post the
    // logs (the likelier reason someone is dumping them) and say what happened.
    let dbNote = "";
    try {
      const db = await getDb(interaction.client);
      files.push(new AttachmentBuilder(
        Buffer.from(JSON.stringify(db, null, 2) ?? "null", "utf8"),
        { name: `db-state-${stamp}.json` },
      ));
    } catch (err) {
      dbNote = `\n⚠️ Couldn't read the db state: ${err.message}`;
    }

    const uptimeMinutes = Math.floor(process.uptime() / 60);
    const uptime = `${Math.floor(uptimeMinutes / 60)}h ${uptimeMinutes % 60}m`;

    try {
      await channel.send({
        content: `🧾 Log dump requested by <@${interaction.user.id}> — PID ${process.pid}, up ${uptime}. Console capture covers this process run only.${dbNote}`,
        files,
      });
    } catch (err) {
      console.error("💥 /dump-logs failed to post:", err);
      return interaction.editReply("❌ Failed to post the dump to the diagnostics channel.");
    }

    await interaction.editReply(`✅ Posted the log dump to <#${DUMP_CHANNEL_ID}>.`);
  },
};

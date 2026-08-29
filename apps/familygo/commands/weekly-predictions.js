import { SlashCommandBuilder } from "discord.js";
import { postWeeklyPredictions } from "../postWeeklyPredictions.js";

export default {
  data: new SlashCommandBuilder()
    .setName("weekly-predictions")
    .setDescription("Post the upcoming Monday–Sunday event schedule (excluding milestones/tournaments).")
    .addBooleanOption((opt) =>
      opt.setName("debug").setDescription("Post to the test channel instead of the live channel")
    ),
  cooldown: 3,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const debug = interaction.options.getBoolean("debug") ?? false;

    try {
      const posted = await postWeeklyPredictions(interaction.client, { debug });
      await interaction.editReply(
        !posted
          ? "ℹ️ Weekly predictions not posted — the wiki calendar doesn't cover the upcoming week yet."
          : debug
            ? "✅ Weekly predictions executed in debug mode — posted to the test channel."
            : "✅ Weekly predictions executed successfully."
      );
    } catch (err) {
      console.error("💥 Weekly predictions command failed:", err);
      await interaction.editReply("❌ Failed to run weekly predictions.");
    }
  },
};

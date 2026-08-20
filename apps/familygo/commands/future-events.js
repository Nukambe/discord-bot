import { SlashCommandBuilder } from "discord.js";
import { postFutureEventsToDiscord } from "../postFutureEvents.js";

export default {
  data: new SlashCommandBuilder()
    .setName("future-events")
    .setDescription("Post today's/yesterday's Monopoly GO Wiki news posts (excluding daily events).")
    .addBooleanOption((opt) =>
      opt.setName("debug").setDescription("Post to the test channel instead of the live channel")
    ),
  cooldown: 3,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const debug = interaction.options.getBoolean("debug") ?? false;

    try {
      await postFutureEventsToDiscord(interaction.client, { debug });
      await interaction.editReply(
        debug
          ? "✅ Future events executed in debug mode — posted to the test channel."
          : "✅ Future events executed successfully."
      );
    } catch (err) {
      console.error("💥 Future events command failed:", err);
      await interaction.editReply("❌ Failed to run future events.");
    }
  },
};

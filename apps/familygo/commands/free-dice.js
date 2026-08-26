import { SlashCommandBuilder } from "discord.js";
import { postNewFreeDiceLinks } from "../postFreeDiceLinks.js";

export default {
  data: new SlashCommandBuilder()
    .setName("free-dice")
    .setDescription("Post any of today's/yesterday's free dice links that haven't been posted yet.")
    .addBooleanOption((opt) =>
      opt.setName("debug").setDescription("Post to the test channel instead of the live channel")
    ),
  cooldown: 3,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const debug = interaction.options.getBoolean("debug") ?? false;

    try {
      await postNewFreeDiceLinks(interaction.client, { debug });
      await interaction.editReply(
        debug
          ? "✅ Free dice check executed in debug mode — posted to the test channel."
          : "✅ Free dice check complete — any new links were posted."
      );
    } catch (err) {
      console.error("💥 Free dice command failed:", err);
      await interaction.editReply("❌ Failed to run the free dice check.");
    }
  },
};

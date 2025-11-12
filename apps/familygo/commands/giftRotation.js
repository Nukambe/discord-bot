import { SlashCommandBuilder } from "discord.js";
import { runGiftRotation } from "../giftRotation.js";

export default {
  data: new SlashCommandBuilder()
    .setName("gift-rotation")
    .setDescription("Choose the next giftee."),
  cooldown: 3,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true }); // optional: prevents timeout

    try {
      // Use the client from the interaction context
      await runGiftRotation(interaction.client);
      await interaction.editReply("✅ Gift rotation executed successfully.");
    } catch (err) {
      console.error("💥 Gift rotation command failed:", err);
      await interaction.editReply("❌ Failed to run gift rotation.");
    }
  },
};

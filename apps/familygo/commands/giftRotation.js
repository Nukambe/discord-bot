import { SlashCommandBuilder } from "discord.js";
import { runGiftRotation, rotatedToday } from "../giftRotation.js";

export default {
  data: new SlashCommandBuilder()
    .setName("gift-rotation")
    .setDescription("Choose the next giftee. Today's scheduled rotation is skipped if this runs first.")
    .addBooleanOption((opt) =>
      opt.setName("force").setDescription("Pick again even though a rotation was already posted today")
    ),
  cooldown: 3,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true }); // optional: prevents timeout

    const force = interaction.options.getBoolean("force") ?? false;

    try {
      // One rotation per day: it announces gifting for tomorrow, so a second pick today
      // would be a second giftee for the same day (and the scheduled run skips for the
      // same reason once this one has posted).
      if (!force && (await rotatedToday(interaction.client))) {
        await interaction.editReply(
          "ℹ️ A gift rotation was already posted today, so nobody new was picked. Use `force: True` to pick again anyway."
        );
        return;
      }

      // Use the client from the interaction context
      await runGiftRotation(interaction.client);
      await interaction.editReply("✅ Gift rotation executed successfully. The scheduled rotation won't pick again today.");
    } catch (err) {
      console.error("💥 Gift rotation command failed:", err);
      await interaction.editReply("❌ Failed to run gift rotation.");
    }
  },
};

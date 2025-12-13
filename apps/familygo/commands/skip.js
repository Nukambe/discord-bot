import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { setSkipNextRotation } from "../giftRotation.js";

export default {
  data: new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the next scheduled gift rotation (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  cooldown: 3,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      await setSkipNextRotation(interaction.client);
      await interaction.editReply("✅ The next gift rotation has been skipped. It will resume on the following scheduled day.");
    } catch (err) {
      console.error("💥 Skip rotation command failed:", err);
      await interaction.editReply("❌ Failed to skip next rotation.");
    }
  },
};

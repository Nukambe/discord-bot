import { SlashCommandBuilder } from "discord.js";
import { postCollectibleSpoilers } from "../postCollectibleSpoilers.js";

export default {
  data: new SlashCommandBuilder()
    .setName("spoilers")
    .setDescription("Post any dice skins, shields or tokens the wiki has added since the last check.")
    .addBooleanOption((opt) =>
      opt.setName("debug").setDescription("Post the newest few of each to the test channel, ignoring what's already been posted")
    ),
  cooldown: 3,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const debug = interaction.options.getBoolean("debug") ?? false;

    try {
      await postCollectibleSpoilers(interaction.client, { debug });
      await interaction.editReply(
        debug
          ? "✅ Collectible check executed in debug mode — posted to the test channel."
          : "✅ Collectible check complete — any new collectibles were posted."
      );
    } catch (err) {
      console.error("💥 Spoilers command failed:", err);
      await interaction.editReply("❌ Failed to run the collectible check.");
    }
  },
};

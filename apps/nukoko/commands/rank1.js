import { SlashCommandBuilder, AttachmentBuilder } from "discord.js";
import path from "node:path";

export default {
  data: new SlashCommandBuilder()
    .setName("rank1")
    .setDescription("Displays the Rank 1 image"),
  async execute(interaction) {
    const file = new AttachmentBuilder(path.resolve("apps/nukoko/media/rank1.png"));
    await interaction.reply({ files: [file] });
  },
};

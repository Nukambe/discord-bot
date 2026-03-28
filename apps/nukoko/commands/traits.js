import { SlashCommandBuilder, AttachmentBuilder } from "discord.js";
import { readdirSync } from "node:fs";
import path from "node:path";

export default {
  data: new SlashCommandBuilder()
    .setName("traits")
    .setDescription("Displays all traits"),
  async execute(interaction) {
    const traitsDir = path.resolve("apps/nukoko/media/traits");
    const files = readdirSync(traitsDir).filter((f) =>
      /\.(png|jpg|jpeg|gif|webp)$/i.test(f)
    );

    const attachments = files.map(
      (f) => new AttachmentBuilder(path.join(traitsDir, f))
    );

    await interaction.reply({ files: attachments });
  },
};

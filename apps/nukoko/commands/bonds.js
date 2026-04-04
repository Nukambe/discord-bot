import { SlashCommandBuilder, AttachmentBuilder } from "discord.js";
import { readdirSync } from "node:fs";
import path from "node:path";

const bondsDir = path.resolve("apps/nukoko/media/bonds");

const characters = readdirSync(bondsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

export default {
  data: new SlashCommandBuilder()
    .setName("bonds")
    .setDescription("Displays bond images for a character")
    .addStringOption((option) =>
      option
        .setName("character")
        .setDescription("The character to show bonds for")
        .setRequired(true)
        .addChoices(...characters.map((name) => ({ name, value: name })))
    ),
  async execute(interaction) {
    const character = interaction.options.getString("character");
    const charDir = path.join(bondsDir, character);

    const files = readdirSync(charDir).filter((f) =>
      /\.(png|jpg|jpeg|gif|webp)$/i.test(f)
    );

    if (files.length === 0) {
      return interaction.reply({ content: `No bond images found for **${character}**.`, ephemeral: true });
    }

    const attachments = files.map((f) => new AttachmentBuilder(path.join(charDir, f)));
    await interaction.reply({ files: attachments });
  },
};

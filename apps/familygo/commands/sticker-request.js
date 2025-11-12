// apps/familygo/commands/sticker-request.js
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";

const GIF_URL =
  "https://tenor.com/view/squidward-spare-change-spare-some-change-begging-poor-gif-18999842";

export default {
  data: new SlashCommandBuilder()
    .setName("sticker-request")
    .setDescription("Ask someone for stickers.")
    .addUserOption(option =>
      option
        .setName("person")
        .setDescription("Who are you asking for stickers?")
        .setRequired(true)
    ),

  cooldown: 3,

  async execute(interaction) {
    const user = interaction.options.getUser("person");

    const embed = new EmbedBuilder()
      .setDescription(`🧩 **Sticker Request**\nHey <@${user.id}>, got any spare stickers? 👀`)
      .setImage(GIF_URL)
      .setColor(0x00aeff);

    await interaction.reply({ embeds: [embed] });
  },
};

// apps/familygo/commands/sticker-request.js
import { SlashCommandBuilder } from "discord.js";

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

    const message = [
      `🧩 **Sticker Request**`,
      `Hey <@${user.id}>, got any spare stickers? 👀`,
      "",
      GIF_URL,
    ].join("\n");

    await interaction.reply(message);
  },
};

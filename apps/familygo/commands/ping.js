import { SlashCommandBuilder } from "discord.js";

export default {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if the bot is alive"),
  cooldown: 3,
  async execute(interaction) {
    await interaction.reply("🏓 Pong!");
  },
};

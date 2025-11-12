import { SlashCommandBuilder } from "discord.js";

export default {
  data: new SlashCommandBuilder()
    .setName("next")
    .setDescription("Get the next time the bot will post events."),
  cooldown: 3,
  async execute(interaction) {
    await interaction.reply("Running daily script (7:30 PM EST)");
  },
};

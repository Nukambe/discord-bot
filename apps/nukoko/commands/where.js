import { SlashCommandBuilder } from "discord.js";

const GIF = "https://klipy.com/gifs/pulp-fiction-john-travolta-kFn";

export default {
  data: new SlashCommandBuilder()
    .setName("where")
    .setDescription("Ask someone where the stream is")
    .addUserOption((option) =>
      option.setName("member").setDescription("Who to ask").setRequired(true)
    ),
  async execute(interaction) {
    const target = interaction.options.getUser("member");
    await interaction.reply({ content: `${target} Where's the stream?\n${GIF}` });
  },
};

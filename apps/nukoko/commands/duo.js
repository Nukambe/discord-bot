import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const PLACEHOLDER_GIF = "https://klipy.com/gifs/super-saiyan-god-goku-and-super-saiyan-god-vegeta-divine-warriors-with-infinite-power-20";

export default {
  data: new SlashCommandBuilder()
    .setName("duo")
    .setDescription("Ask someone to duo with you")
    .addUserOption((option) =>
      option.setName("player").setDescription("Who do you want to duo with?").setRequired(true)
    ),
  async execute(interaction) {
    const target = interaction.options.getUser("player");
    const requester = interaction.user;

    if (target.id === requester.id) {
      return interaction.reply({ content: "You can't duo with yourself!", ephemeral: true });
    }

    const acceptId = `duo_accept_${interaction.id}`;
    const declineId = `duo_decline_${interaction.id}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(acceptId).setLabel("Accept").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(declineId).setLabel("Decline").setStyle(ButtonStyle.Danger)
    );

    await interaction.reply({
      content: `${target} — **${requester.displayName}** wants to duo! Are you in?\n${PLACEHOLDER_GIF}`,
      components: [row],
    });

    const collector = interaction.channel.createMessageComponentCollector({
      filter: (i) => [acceptId, declineId].includes(i.customId) && i.user.id === target.id,
      time: 60_000,
      max: 1,
    });

    collector.on("collect", async (i) => {
      if (i.customId === acceptId) {
        await i.update({
          content: `✅ ${target} accepted the duo request from **${requester.displayName}**! Let's go! 🎮`,
          components: [],
        });
        await i.message.react("westbrook_kiss:1472813740301750375").catch(() => {});
      } else {
        await i.update({
          content: `❌ ${target} declined the duo request from **${requester.displayName}**.`,
          components: [],
        });
        await i.message.react("zion_angry:1472813741404852274").catch(() => {});
      }
    });

    collector.on("end", async (collected) => {
      if (collected.size === 0) {
        const msg = await interaction.fetchReply().catch(() => null);
        if (msg) {
          await msg.edit({ components: [] }).catch(() => {});
          const noReply = await interaction.channel.send(`${target} left **${requester.displayName}** on read. 💀`).catch(() => null);
          if (noReply) await noReply.react("bron_crying:1472813733016375443").catch(() => {});
        }
      }
    });
  },
};

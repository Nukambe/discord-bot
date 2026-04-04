import { SlashCommandBuilder } from "discord.js";
import { replyWithImage } from "../_replyWithImage.js";

export default {
  data: new SlashCommandBuilder()
    .setName("rank1")
    .setDescription("Displays the Rank 1 image"),
  async execute(interaction) {
    const msg = await replyWithImage(interaction, "apps/nukoko/media/rank1.png");
    await msg.react("bron_him:1472813733997969512").catch(() => {});
  },
};

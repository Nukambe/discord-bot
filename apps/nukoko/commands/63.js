import { SlashCommandBuilder } from "discord.js";
import { replyWithImage } from "../_replyWithImage.js";

export default {
  data: new SlashCommandBuilder()
    .setName("63")
    .setDescription("Displays the 63 image"),
  async execute(interaction) {
    await replyWithImage(interaction, "apps/nukoko/media/63.png");
  },
};

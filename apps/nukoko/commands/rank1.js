import { SlashCommandBuilder, AttachmentBuilder } from "discord.js";
import { readdirSync } from "node:fs";
import path from "node:path";

const rank1Dir = path.resolve("apps/nukoko/media/rank1");

export default {
  data: new SlashCommandBuilder()
    .setName("rank1")
    .setDescription("Displays the Rank 1 images"),
  async execute(interaction) {
    const files = readdirSync(rank1Dir).filter((f) =>
      /\.(png|jpg|jpeg|gif|webp)$/i.test(f)
    );

    const attachments = files.map((f) => new AttachmentBuilder(path.join(rank1Dir, f)));
    const msg = await interaction.reply({ files: attachments, fetchReply: true });
    await msg.react("bron_him:1472813733997969512").catch(() => {});
  },
};

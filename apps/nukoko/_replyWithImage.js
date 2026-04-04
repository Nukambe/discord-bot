import { AttachmentBuilder } from "discord.js";
import path from "node:path";

export async function replyWithImage(interaction, relativePath) {
  const file = new AttachmentBuilder(path.resolve(relativePath));
  const msg = await interaction.reply({ files: [file], fetchReply: true });
  return msg;
}

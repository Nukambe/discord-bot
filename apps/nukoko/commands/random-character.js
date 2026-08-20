import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { CHARACTERS, POSITIONS, POSITION_OF, ALL_NAMES } from "../roster.js";

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default {
  data: new SlashCommandBuilder()
    .setName("random-character")
    .setDescription("Pick a random character, optionally from a single position")
    .addStringOption((option) =>
      option
        .setName("position")
        .setDescription("Limit the pick to one position")
        .addChoices(
          ...Object.entries(POSITIONS).map(([value, name]) => ({ name: `${name} (${value})`, value }))
        )
    ),
  cooldown: 3,
  async execute(interaction) {
    const position = interaction.options.getString("position");
    const pool = position ? CHARACTERS[position] : ALL_NAMES;
    const character = pickRandom(pool);
    const pick = position ?? POSITION_OF.get(character);

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle("🎲 Random Character")
      .setDescription(`**${character}**`)
      .addFields({ name: "Position", value: `${POSITIONS[pick]} (${pick})`, inline: true })
      .setFooter({ text: position ? `Rolled from ${POSITIONS[position]}` : "Rolled from the full roster" });

    await interaction.reply({ embeds: [embed] });
  },
};

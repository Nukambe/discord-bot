import { SlashCommandBuilder, EmbedBuilder } from "discord.js";

// Copied from apps/twitch/commands/character-request.js — the two bots are
// independent, so this roster is intentionally duplicated rather than shared.
const CHARACTERS = {
  PG: ["Yukio Kasamatsu", "Kazunari Takao", "Shoichi Imayoshi", "Koki Furihata", "Seijuro Akashi", "Shun Izuki", "Nash Gold Jr.", "SP Akashi"],
  SG: ["Junpei Hyuga", "Ryo Sakurai", "Yoshitaka Moriyama", "Tatsuya Himuro", "Reo Mibuchi", "Shintaro Midorima", "Diviner Midorima"],
  SF: ["Shinji Koganei", "Ryota Kise", "Liu Wei", "Perfect Copy Kise"],
  PF: ["Taiga Kagami", "LAST GAME Kagami", "Mitsuhiro Hayakawa", "Satoshi Tsuchida", "Daiki Aomine", "Chihiro Mayuzumi"],
  C: ["Rinnosuke Mitobe", "Taisuke Otsubo", "Atsushi Murasakibara", "Kosuke Wakamatsu", "Koji Kobori", "Teppei Kiyoshi", "Jason Silver"],
  // Kuroko's in-game position tag is "?" (Phantom Sixth Man, doesn't fit the standard 5 positions)
  "?": ["Tetsuya Kuroko", "Miracle Tetsuya"],
};

const POSITIONS = {
  PG: "Point Guard",
  SG: "Shooting Guard",
  SF: "Small Forward",
  PF: "Power Forward",
  C: "Center",
  "?": "Special",
};

const POSITION_OF = new Map(
  Object.entries(CHARACTERS).flatMap(([pos, names]) => names.map((name) => [name, pos]))
);

const ALL_NAMES = Object.values(CHARACTERS).flat();

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

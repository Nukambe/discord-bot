import { SlashCommandBuilder, EmbedBuilder } from "discord.js";

const luckyItems = [
  {
    name: "🐸 Frog",
    value: "• Reduces defensive zone by 1m and displays the defensive zone in frog shape.",
  },
  {
    name: "🦝 Tanuki",
    value: [
      "• When 3-pointers are made, generates a Tanuki-shaped area at that location",
      "• Zone: Dribble speed and off-ball speed +3 for 2s",
      "• Zone: +10% 3pt Accuracy",
    ].join("\n"),
  },
  {
    name: "🦝 Raccoon",
    value: [
      "• Faster shots",
      "• Open shots guaranteed",
      "• 5% Contest Resist",
    ].join("\n"),
  },
  {
    name: "🐻 Wooden Bear",
    value: [
      "• When using skills, opponents in ankle-broken state within the defensive zone cannot interfere with Midorima. His shots count as open shots.",
      "• When using skill shots, opponents must jump",
    ].join("\n"),
  },
  {
    name: "🦆 Rubber Duck",
    value: [
      "• Shooting skills range +1m",
      "• Extended Range: 3pt Accuracy +5%",
    ].join("\n"),
  },
];

export default {
  data: new SlashCommandBuilder()
    .setName("lucky-items")
    .setDescription("SP Midorima's Lucky Items and their effects"),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle("SP Midorima's Lucky Items")
      .setDescription("Each lucky charm grants a unique passive effect.")
      .addFields(luckyItems);

    await interaction.reply({ embeds: [embed] });
  },
};

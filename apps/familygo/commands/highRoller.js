import { SlashCommandBuilder } from "discord.js";

export default {
  data: new SlashCommandBuilder()
    .setName("high-roller")
    .setDescription("May the odds be ever in your favor."),
  cooldown: 3,

  async execute(interaction) {
    // Positive decisions
    const yesResponses = [
      "🎲 Absolutely — today’s your lucky roll!",
      "💰 Definitely yes — maximize those rewards!",
      "✅ Go for it — fortune favors the bold!",
      "🔥 100%! It’s your High Roller moment!",
    ];

    // Negative or cautious decisions
    const noResponses = [
      "🚫 Not today — save your dice!",
      "🤔 Maybe hold off for now.",
      "🧿 The spirits say... *no*, not this time.",
      "🕓 Wait until later — better odds might come soon.",
    ];

    // Weighted random choice
    const isYes = Math.random() < 0.4;

    const decisions = isYes ? yesResponses : noResponses;
    const decision = decisions[Math.floor(Math.random() * decisions.length)];

    // Only pick multiplier if yes
    let reply = `<:HighRoller:1437570229390545008> **Monopoly GO High Roller Oracle**\n\n${decision}`;

    const multipliers = isYes ? ["x1000", "x500", "x200"] : ["x100", "x50", "x20", "x10", "x5", "x2", "x1"];
    const multiplier = multipliers[Math.floor(Math.random() * multipliers.length)];
    reply += `\nRecommended Multiplier: **${multiplier}**`;

    await interaction.reply(reply);
  },
};

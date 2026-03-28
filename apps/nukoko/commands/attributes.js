import { SlashCommandBuilder, EmbedBuilder } from "discord.js";

const attributes = {
  "Close Shot": ["Affect the chance of hitting Close Shots"],
  "Mid-Range": ["Affect the chance of hitting Mid-Range Shots"],
  "3 Pointer": ["Affect the chance of hitting 3 Pointers"],
  "Dunk": [
    "Affect the chance of hitting dunks",
    "Affect the chance of dunking when shooting with joystick",
    "Affect the dunking range",
  ],
  "Layup": [
    "Affect the chance of hitting layups",
    "Affect the chance of using layup when shooting with joystick",
    "Affect the layup range",
  ],
  "Jump": [
    "Affect the block height",
    "Affect the rebound height (Pass, Tip in, Tip Shot)",
    "Affect the chance of winning the rebound (Pass, Tip in, Tip Shot)",
  ],
  "Rebound": [
    "Affect the rebound radius",
    "Affect the chance of winning the rebound (Pass, Tip in, Tip Shot, Jump Ball)",
  ],
  "Steal": [
    "Affect the chance of stealing the ball",
    "Affect the chance of touching the ball when stealing",
    "Affect the chance of triggering intercept",
    "Affect the chance of touching the ball when intercepting",
  ],
  "Block": [
    "Affect the block range",
    "Affect the chance of blocking the shot",
  ],
  "Goaltending": [
    "Affect chance of hitting all shots",
    "Affect the stability when the Rival receives the ball",
  ],
  "Intercept Resistance": [
    "Affect the chance of hitting all shots",
    "Affect the stability of passing the ball",
  ],
  "Strength": [
    "Affect the chance of intercepting a driving Rival (or being intercepted)",
    "Affect the chance of setting a successful screen (or being blocked by a screen)",
    "Affect the chance of stopping the Rival from dribbling using your body (or being stopped)",
    "Affect the chancing of pushing the Rival back using the post move (or being pushed back)",
    "Affect the chance of boxing out",
    "Affect the chance of winning the body contest when dunking/blocking",
  ],
  "Ball Handling": [
    "Affect the chance of stealing the ball",
    "Affect the chance of touching the ball when stealing",
    "Affect the chance of intercepting the ball",
    "Affect the chance of touching the ball when intercepting",
    "Affect the stability of passing the ball",
    "Affect the safe passing distance",
    "Affect the ankle breaking chance",
  ],
  "Run": [
    "Affect the movement speed without the ball in hand",
    "Affect the moving acceleration",
    "Affect the boxing out speed",
    "Affect the defense speed",
  ],
  "Dribble": [
    "Affect the movement speed while dribbling",
    "Affect the post-up movement speed",
  ],
};

export default {
  data: new SlashCommandBuilder()
    .setName("attributes")
    .setDescription("Shows what each attribute affects"),
  async execute(interaction) {
    const fields = Object.entries(attributes).map(([name, effects]) => ({
      name: `🏀 ${name}`,
      value: effects.map((e) => `• ${e}`).join("\n"),
    }));

    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle("Player Attributes")
      .setDescription("What each attribute affects in-game")
      .addFields(fields);

    await interaction.reply({ embeds: [embed] });
  },
};

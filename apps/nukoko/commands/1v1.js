import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

const games = new Map();

const CHALLENGER_MOVES = ["shoot", "pump_fake", "drive"];
const OPPONENT_MOVES = ["block", "steal", "face_up"];

const MOVE_LABELS = {
  shoot: "🏀 Shoot",
  pump_fake: "🤸 Pump Fake",
  drive: "💨 Drive",
  block: "🚫 Block",
  steal: "🤚 Steal",
  face_up: "🧱 Face Up",
};

// "challenger" = challenger wins this round, "opponent" = opponent wins
const RESULTS = {
  shoot:     { block: "opponent",    steal: "challenger", face_up: "challenger" },
  pump_fake: { block: "challenger",  steal: "opponent",   face_up: "challenger" },
  drive:     { block: "challenger",  steal: "challenger", face_up: "opponent"   },
};

function getRoundEmbed(g) {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`⚔️ Round ${g.round}/3`)
    .setDescription(`**${g.challenger.displayName}** vs **${g.opponent.displayName}**`)
    .addFields(
      { name: g.challenger.displayName, value: g.currentPicks.challenger ? "✅ Locked in" : "🔵 Waiting...", inline: true },
      { name: g.opponent.displayName,   value: g.currentPicks.opponent   ? "✅ Locked in" : "🔵 Waiting...", inline: true }
    );
}

function getRoundRow(gameId, round, g) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`1v1_req_c_${gameId}_${round}`)
      .setLabel("Make your move")
      .setStyle(g.currentPicks.challenger ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!!g.currentPicks.challenger),
    new ButtonBuilder()
      .setCustomId(`1v1_req_o_${gameId}_${round}`)
      .setLabel("Make your move")
      .setStyle(g.currentPicks.opponent ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!!g.currentPicks.opponent)
  );
}

function getMoveRow(gameId, round, moves, side) {
  return new ActionRowBuilder().addComponents(
    moves.map((m) =>
      new ButtonBuilder()
        .setCustomId(`1v1_move_${gameId}_${round}_${side}_${m}`)
        .setLabel(MOVE_LABELS[m])
        .setStyle(ButtonStyle.Primary)
    )
  );
}

async function startRound(game, channel) {
  game.currentPicks = { challenger: null, opponent: null };

  const msg = await channel.send({
    embeds: [getRoundEmbed(game)],
    components: [getRoundRow(game.id, game.round, game)],
  });
  game.roundMessage = msg;

  game.roundTimeout = setTimeout(async () => {
    if (!games.has(game.id)) return;
    games.delete(game.id);
    await msg.edit({
      embeds: [
        new EmbedBuilder()
          .setColor(0x95a5a6)
          .setTitle("⏰ 1v1 timed out")
          .setDescription("A player didn't respond in time."),
      ],
      components: [],
    }).catch(() => {});
  }, 60_000);
}

async function resolveRound(game, channel) {
  clearTimeout(game.roundTimeout);

  const { challenger, opponent, currentPicks, round } = game;
  const cMove = currentPicks.challenger;
  const oMove = currentPicks.opponent;
  const winner = RESULTS[cMove][oMove];

  if (winner === "challenger") game.scores.challenger++;
  else game.scores.opponent++;

  game.challengerUsedMoves.push(cMove);
  game.opponentUsedMoves.push(oMove);

  const winnerName = winner === "challenger" ? challenger.displayName : opponent.displayName;

  await game.roundMessage.edit({
    embeds: [
      new EmbedBuilder()
        .setColor(winner === "challenger" ? 0x2ecc71 : 0xe74c3c)
        .setTitle(`⚔️ Round ${round}/3 Result`)
        .addFields(
          { name: challenger.displayName, value: MOVE_LABELS[cMove], inline: true },
          { name: "\u200b",               value: "**vs**",            inline: true },
          { name: opponent.displayName,   value: MOVE_LABELS[oMove],  inline: true }
        )
        .setDescription(
          `🏆 **${winnerName}** wins the round!\nScore: **${challenger.displayName}** ${game.scores.challenger} — ${game.scores.opponent} **${opponent.displayName}**`
        ),
    ],
    components: [],
  }).catch(() => {});

  if (round === 3) {
    games.delete(game.id);
    const gameWinner =
      game.scores.challenger > game.scores.opponent ? challenger
      : game.scores.opponent > game.scores.challenger ? opponent
      : null;

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(gameWinner ? 0xf1c40f : 0x95a5a6)
          .setTitle("🏆 Game Over!")
          .setDescription(
            gameWinner
              ? `**${gameWinner.displayName}** wins the 1v1! (${game.scores.challenger}—${game.scores.opponent})`
              : `It's a tie! (${game.scores.challenger}—${game.scores.opponent})`
          ),
      ],
    });
  } else {
    game.round++;
    setTimeout(() => startRound(game, channel), 2000);
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName("1v1")
    .setDescription("Challenge someone to a 1v1")
    .addUserOption((o) =>
      o.setName("opponent").setDescription("Who do you want to 1v1?").setRequired(true)
    ),

  async execute(interaction) {
    const challengerMember = interaction.member;
    const opponentUser = interaction.options.getUser("opponent");

    if (opponentUser.id === interaction.user.id) {
      return interaction.reply({ content: "You can't 1v1 yourself!", ephemeral: true });
    }

    const opponentMember = await interaction.guild.members.fetch(opponentUser.id);
    const gameId = interaction.id;

    const game = {
      id: gameId,
      challenger: challengerMember,
      opponent: opponentMember,
      round: 1,
      scores: { challenger: 0, opponent: 0 },
      challengerUsedMoves: [],
      opponentUsedMoves: [],
      currentPicks: { challenger: null, opponent: null },
      roundMessage: null,
      roundTimeout: null,
    };

    games.set(gameId, game);

    await interaction.reply({
      content: `⚔️ **${challengerMember.displayName}** challenged **${opponentMember.displayName}** to a 1v1! Get ready...`,
    });

    const channel = interaction.channel;

    const collector = channel.createMessageComponentCollector({
      filter: (i) => i.customId.includes(gameId),
      time: 300_000,
    });

    collector.on("collect", async (i) => {
      const g = games.get(gameId);
      if (!g) return;

      const { customId } = i;

      // "Make your move" buttons
      if (customId.startsWith(`1v1_req_c_${gameId}`)) {
        if (i.user.id !== g.challenger.id)
          return i.reply({ content: "That's not your button!", ephemeral: true });
        if (g.currentPicks.challenger)
          return i.reply({ content: "You already locked in your pick!", ephemeral: true });

        const available = CHALLENGER_MOVES.filter((m) => !g.challengerUsedMoves.includes(m));
        return i.reply({ content: "Choose your move:", components: [getMoveRow(gameId, g.round, available, "c")], ephemeral: true });
      }

      if (customId.startsWith(`1v1_req_o_${gameId}`)) {
        if (i.user.id !== g.opponent.id)
          return i.reply({ content: "That's not your button!", ephemeral: true });
        if (g.currentPicks.opponent)
          return i.reply({ content: "You already locked in your pick!", ephemeral: true });

        const available = OPPONENT_MOVES.filter((m) => !g.opponentUsedMoves.includes(m));
        return i.reply({ content: "Choose your move:", components: [getMoveRow(gameId, g.round, available, "o")], ephemeral: true });
      }

      // Move selection: 1v1_move_{gameId}_{round}_{side}_{move...}
      if (customId.startsWith(`1v1_move_${gameId}`)) {
        const suffix = customId.slice(`1v1_move_${gameId}_`.length); // "{round}_{side}_{move}"
        const [roundStr, side, ...moveParts] = suffix.split("_");
        const move = moveParts.join("_");
        const roundNum = parseInt(roundStr);

        if (roundNum !== g.round)
          return i.reply({ content: "This round has already ended!", ephemeral: true });

        if (side === "c") {
          if (i.user.id !== g.challenger.id)
            return i.reply({ content: "That's not your pick!", ephemeral: true });
          if (g.currentPicks.challenger)
            return i.reply({ content: "You already picked!", ephemeral: true });
          g.currentPicks.challenger = move;
          await i.update({ content: "✅ Locked in! Waiting for opponent...", components: [] });
        } else {
          if (i.user.id !== g.opponent.id)
            return i.reply({ content: "That's not your pick!", ephemeral: true });
          if (g.currentPicks.opponent)
            return i.reply({ content: "You already picked!", ephemeral: true });
          g.currentPicks.opponent = move;
          await i.update({ content: "✅ Locked in! Waiting for opponent...", components: [] });
        }

        // Update public round message to reflect who has locked in
        await g.roundMessage
          .edit({ embeds: [getRoundEmbed(g)], components: [getRoundRow(gameId, g.round, g)] })
          .catch(() => {});

        // Both picked — resolve
        if (g.currentPicks.challenger && g.currentPicks.opponent) {
          await resolveRound(g, channel);
        }
      }
    });

    collector.on("end", () => {
      games.delete(gameId);
    });

    setTimeout(() => startRound(game, channel), 1500);
  },
};

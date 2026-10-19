import { SlashCommandBuilder } from "discord.js";
import { runGiftRotation, rotatedToday, setNextGiftee, getGiftPools } from "../giftRotation.js";

/** The `next` option's value that clears a pinned pick instead of setting one. */
const CLEAR_NEXT = "clear";

export default {
  data: new SlashCommandBuilder()
    .setName("gift-rotation")
    .setDescription("Choose the next giftee. Today's scheduled rotation is skipped if this runs first.")
    .addStringOption((opt) =>
      opt
        .setName("winner")
        .setDescription("Run the rotation now with this giftee as the winner, whoever is left this cycle")
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("next")
        .setDescription("Don't run now — make this giftee the winner of the next rotation (even after a pause)")
        .setAutocomplete(true)
    )
    .addBooleanOption((opt) =>
      opt.setName("force").setDescription("Pick again even though a rotation was already posted today")
    ),
  cooldown: 3,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const typed = focused.value.trim().toLowerCase();
    const { giftees } = await getGiftPools(interaction.client);

    const choices = giftees
      .map((g) => ({ name: g.name || g.id, value: g.id }))
      .filter((c) => !typed || c.name.toLowerCase().includes(typed));
    if (focused.name === "next") choices.push({ name: "Clear the next pick", value: CLEAR_NEXT });
    await interaction.respond(choices.slice(0, 25));
  },

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true }); // optional: prevents timeout

    const force = interaction.options.getBoolean("force") ?? false;
    const winnerInput = interaction.options.getString("winner");
    const nextInput = interaction.options.getString("next");

    try {
      if (winnerInput && nextInput) {
        await interaction.editReply("❌ Use either `winner` (pick now) or `next` (pick at the next rotation), not both.");
        return;
      }

      const { giftees } = await getGiftPools(interaction.client);
      // A typed name that wasn't picked from the list still resolves, by name or id.
      const resolve = (input) => giftees.find(
        (g) => g.id === input || (g.name && g.name.toLowerCase() === input.trim().toLowerCase())
      );
      const label = (g) => (/^[0-9]{17,20}$/.test(g.id) ? `<@${g.id}>` : `**${g.name || g.id}**`);

      if (nextInput) {
        if (nextInput === CLEAR_NEXT) {
          await setNextGiftee(interaction.client, null);
          await interaction.editReply("✅ Cleared the next pick — the next rotation picks from the cycle as usual.");
          return;
        }
        const giftee = resolve(nextInput);
        if (!giftee) {
          await interaction.editReply(`❌ \`${nextInput}\` isn't on the giftee roster (see \`/gift-pool view\`).`);
          return;
        }
        await setNextGiftee(interaction.client, giftee.id);
        await interaction.editReply(
          `✅ ${label(giftee)} will be the winner of the next rotation, including after a pause. Nothing was posted now.`
        );
        return;
      }

      const winner = winnerInput ? resolve(winnerInput) : null;
      if (winnerInput && !winner) {
        await interaction.editReply(`❌ \`${winnerInput}\` isn't on the giftee roster (see \`/gift-pool view\`).`);
        return;
      }

      // One rotation per day: it announces gifting for tomorrow, so a second pick today
      // would be a second giftee for the same day (and the scheduled run skips for the
      // same reason once this one has posted).
      if (!force && (await rotatedToday(interaction.client))) {
        await interaction.editReply(
          "ℹ️ A gift rotation was already posted today, so nobody new was picked. Use `force: True` to pick again anyway."
        );
        return;
      }

      // Use the client from the interaction context
      await runGiftRotation(interaction.client, { winner: winner?.id });
      await interaction.editReply(
        `✅ Gift rotation executed successfully${winner ? ` with ${label(winner)} as the winner` : ""}. The scheduled rotation won't pick again today.`
      );
    } catch (err) {
      console.error("💥 Gift rotation command failed:", err);
      await interaction.editReply("❌ Failed to run gift rotation.");
    }
  },
};

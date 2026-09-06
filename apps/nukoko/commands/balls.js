import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from "discord.js";
import {
  addBall,
  removeBall,
  listBalls,
  listUserBalls,
  searchBallUsers,
  BallsError,
  MAX_BALLS_PER_USER,
  MAX_IMAGE_BYTES,
} from "../ballsDb.js";

const EMBED_COLOR = 0x2ecc71;

// Mirrors /builds, but records are keyed by the user who added them instead of
// a roster character. `show` takes a plain-text username (autocompleted from
// the stored entries) so nobody has to @-mention anyone to look them up.
export default {
  data: new SlashCommandBuilder()
    .setName("balls")
    .setDescription("Saved ball images, per user")
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("Show a user's saved balls")
        .addStringOption((option) =>
          option
            .setName("user")
            .setDescription("The user to show balls for (their name, no @ needed)")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Save a ball image under your name")
        .addAttachmentOption((option) =>
          option
            .setName("image")
            .setDescription("The ball image")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a ball you added")
        .addStringOption((option) =>
          option
            .setName("id")
            .setDescription("The ball ID, shown under each image in /balls show")
            .setRequired(true)
            .setAutocomplete(true)
        )
    ),
  cooldown: 3,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    try {
      if (focused.name === "user") {
        const names = await searchBallUsers(interaction.client, focused.value);
        return await interaction.respond(names.map((name) => ({ name, value: name })));
      }

      if (focused.name === "id") {
        // Only the caller's own balls — those are the only ones they can remove.
        const mine = await listUserBalls(interaction.client, interaction.user.id);
        const needle = focused.value.trim().toLowerCase();
        const matches = needle ? mine.filter((b) => b.id.includes(needle)) : mine;

        return await interaction.respond(
          matches.slice(0, 25).map((b) => ({
            name: `Added ${new Date(b.ts).toLocaleDateString("en-US")} — ${b.id}`.slice(0, 100),
            value: b.id,
          }))
        );
      }
    } catch (err) {
      console.error("💥 /balls autocomplete failed:", err);
      await interaction.respond([]).catch(() => {});
    }
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === "show") return await showBalls(interaction);
      if (sub === "add") return await addBallFromInteraction(interaction);
      if (sub === "remove") return await removeBallFromInteraction(interaction);
    } catch (err) {
      if (err instanceof BallsError) return replyError(interaction, `⚠️ ${err.message}`);
      throw err;
    }
  },
};

async function replyError(interaction, content) {
  // A deferred reply has to be resolved with editReply — a followUp would
  // leave the "thinking..." placeholder sitting there.
  if (interaction.deferred) return interaction.editReply({ content }).catch(() => {});
  if (interaction.replied) return interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  return interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function showBalls(interaction) {
  const query = interaction.options.getString("user").trim();
  await interaction.deferReply();

  const found = await listBalls(interaction.client, query);
  if (!found) {
    return interaction.editReply(
      `No balls saved for **${query}** — pick a name from the suggestions, or add your own with \`/balls add image:\``
    );
  }

  const usable = found.balls.filter((b) => b.url);
  if (usable.length === 0) {
    return interaction.editReply(`No balls saved for **${found.name}** yet.`);
  }

  // One embed per image (Discord caps a message at 10, which matches the
  // per-user cap exactly).
  const embeds = usable.map((ball, i) =>
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`${found.name} — ball ${i + 1}/${usable.length}`)
      .setDescription(`Added <t:${Math.floor(ball.ts / 1000)}:D>`)
      .setImage(ball.url)
      .setFooter({ text: `ID: ${ball.id}` })
  );

  await interaction.editReply({ embeds });
}

async function addBallFromInteraction(interaction) {
  const attachment = interaction.options.getAttachment("image");

  if (!attachment.contentType?.startsWith("image/")) {
    throw new BallsError("That file isn't an image — attach a PNG, JPG, GIF, or WebP.");
  }
  if (attachment.size > MAX_IMAGE_BYTES) {
    throw new BallsError(`That image is too large (max ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`);
  }

  await interaction.deferReply();
  const name = interaction.user.username;
  const { record, count, messageUrl } = await addBall(interaction.client, {
    userId: interaction.user.id,
    name,
    attachment,
  });

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`Saved a ball for ${name}`)
    .setDescription(
      [
        `${count}/${MAX_BALLS_PER_USER} balls saved for **${name}**.`,
        `View them all with \`/balls show user:${name}\`.`,
        messageUrl ? `[Jump to the saved image](${messageUrl})` : null,
      ].filter(Boolean).join("\n")
    )
    .setFooter({ text: `ID: ${record.id}` });

  await interaction.editReply({ embeds: [embed] });
}

async function removeBallFromInteraction(interaction) {
  const id = interaction.options.getString("id").trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await removeBall(interaction.client, { id, userId: interaction.user.id });
  await interaction.editReply(`🗑️ Removed your ball (\`${id}\`).`);
}

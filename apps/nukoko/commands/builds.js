import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from "discord.js";
import {
  addBuild,
  removeBuild,
  listBuilds,
  listUserBuilds,
  BuildsError,
  MAX_BUILDS_PER_CHARACTER,
  MAX_IMAGE_BYTES,
} from "../buildsDb.js";
import { resolveCharacter, searchCharacters } from "../roster.js";

const EMBED_COLOR = 0x9b59b6;

// Discord allows either root-level options or subcommands, never both, so
// `/builds <character>` has to be spelled `/builds show character:`.
export default {
  data: new SlashCommandBuilder()
    .setName("builds")
    .setDescription("Saved build images for a character")
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("Show the saved builds for a character")
        .addStringOption((option) =>
          option
            .setName("character")
            .setDescription("The character to show builds for")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Save a build image for a character")
        .addStringOption((option) =>
          option
            .setName("character")
            .setDescription("The character this build is for")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addAttachmentOption((option) =>
          option
            .setName("image")
            .setDescription("The build screenshot")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a build you added")
        .addStringOption((option) =>
          option
            .setName("id")
            .setDescription("The build ID, shown under each image in /builds show")
            .setRequired(true)
            .setAutocomplete(true)
        )
    ),
  cooldown: 3,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    try {
      if (focused.name === "character") {
        const names = searchCharacters(focused.value);
        return await interaction.respond(names.map((name) => ({ name, value: name })));
      }

      if (focused.name === "id") {
        // Only the caller's own builds — those are the only ones they can remove.
        const mine = await listUserBuilds(interaction.client, interaction.user.id);
        const needle = focused.value.trim().toLowerCase();
        const matches = needle
          ? mine.filter((b) => b.character.toLowerCase().includes(needle) || b.id.includes(needle))
          : mine;

        return await interaction.respond(
          matches.slice(0, 25).map((b) => ({
            name: `${b.character} — added ${new Date(b.ts).toLocaleDateString("en-US")}`.slice(0, 100),
            value: b.id,
          }))
        );
      }
    } catch (err) {
      console.error("💥 /builds autocomplete failed:", err);
      await interaction.respond([]).catch(() => {});
    }
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === "show") return await showBuilds(interaction);
      if (sub === "add") return await addBuildFromInteraction(interaction);
      if (sub === "remove") return await removeBuildFromInteraction(interaction);
    } catch (err) {
      if (err instanceof BuildsError) return replyError(interaction, `⚠️ ${err.message}`);
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

function requireCharacter(interaction) {
  const raw = interaction.options.getString("character");
  const character = resolveCharacter(raw);
  if (!character) throw new BuildsError(`**${raw}** isn't on the roster — pick a name from the suggestions.`);
  return character;
}

async function showBuilds(interaction) {
  const character = requireCharacter(interaction);
  await interaction.deferReply();

  const builds = await listBuilds(interaction.client, character);
  const usable = builds.filter((b) => b.url);

  if (usable.length === 0) {
    return interaction.editReply(
      `No builds saved for **${character}** yet. Add one with \`/builds add character:${character} image:\``
    );
  }

  // One embed per image (Discord caps a message at 10, which matches the
  // per-character cap exactly).
  const embeds = usable.map((build, i) =>
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`${character} — build ${i + 1}/${usable.length}`)
      .setDescription(`Added by <@${build.by}> • <t:${Math.floor(build.ts / 1000)}:D>`)
      .setImage(build.url)
      .setFooter({ text: `ID: ${build.id}` })
  );

  await interaction.editReply({ embeds });
}

async function addBuildFromInteraction(interaction) {
  const character = requireCharacter(interaction);
  const attachment = interaction.options.getAttachment("image");

  if (!attachment.contentType?.startsWith("image/")) {
    throw new BuildsError("That file isn't an image — attach a PNG, JPG, GIF, or WebP.");
  }
  if (attachment.size > MAX_IMAGE_BYTES) {
    throw new BuildsError(`That image is too large (max ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`);
  }

  await interaction.deferReply();
  const { record, count, messageUrl } = await addBuild(interaction.client, {
    character,
    userId: interaction.user.id,
    attachment,
  });

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`Saved a build for ${character}`)
    .setDescription(
      [
        `${count}/${MAX_BUILDS_PER_CHARACTER} builds saved for **${character}**.`,
        `View them all with \`/builds show character:${character}\`.`,
        messageUrl ? `[Jump to the saved image](${messageUrl})` : null,
      ].filter(Boolean).join("\n")
    )
    .setFooter({ text: `ID: ${record.id}` });

  await interaction.editReply({ embeds: [embed] });
}

async function removeBuildFromInteraction(interaction) {
  const id = interaction.options.getString("id").trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { character } = await removeBuild(interaction.client, { id, userId: interaction.user.id });
  await interaction.editReply(`🗑️ Removed your **${character}** build (\`${id}\`).`);
}

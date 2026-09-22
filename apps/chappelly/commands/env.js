import { SlashCommandBuilder, PermissionFlagsBits, AttachmentBuilder } from "discord.js";
import {
  currentEnv,
  refreshEnv,
  getPath,
  listPaths,
  setEnvValue,
  deleteEnvValue,
  parseEnvValue,
  formatEnvValue,
  PATH_PATTERN,
  RESERVED_KEYS,
} from "../env.js";

/**
 * Direct edit of any env value by dotted path — `KING_USER_ID`,
 * `crons.neema-pill.times`, or a whole `crons.neema-pill` object as JSON.
 * The /cron form is the friendlier way to edit crons; this is the escape hatch
 * that can reach everything, including keys that don't exist yet.
 */

// Discord caps a code-block reply well under this; longer dumps go out as a file.
const MAX_INLINE = 1800;

const validatePath = (path) => {
  if (!PATH_PATTERN.test(path)) return "Keys are dotted paths of letters, digits, `_` and `-` — e.g. `crons.neema-pill.times`.";
  if (RESERVED_KEYS.has(path.split(".")[0])) return `\`${path}\` is managed by the bot and can't be edited.`;
  return null;
};

const codeBlock = (text) => "```json\n" + text + "\n```";

/** Reply with `text` inline when it fits, otherwise as an attached file. */
async function replyWithDump(interaction, title, text, fileName) {
  if (text.length <= MAX_INLINE) {
    await interaction.editReply(`${title}\n${codeBlock(text)}`);
    return;
  }
  await interaction.editReply({
    content: `${title} (too long to show inline, attached)`,
    files: [new AttachmentBuilder(Buffer.from(text, "utf8"), { name: fileName })],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName("env")
    .setDescription("View or directly edit the bot's env (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName("view").setDescription("Show the whole env"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("get")
        .setDescription("Show one env value")
        .addStringOption((opt) =>
          opt.setName("key").setDescription("Dotted path, e.g. crons.neema-pill").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set an env value (JSON for objects/arrays/booleans, otherwise text)")
        .addStringOption((opt) =>
          opt.setName("key").setDescription("Dotted path — existing or new").setRequired(true).setAutocomplete(true),
        )
        .addStringOption((opt) =>
          opt.setName("value").setDescription('e.g. 123456789012345678 or ["06:00","18:00"] or false').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Remove an env key")
        .addStringOption((opt) =>
          opt.setName("key").setDescription("Dotted path").setRequired(true).setAutocomplete(true),
        ),
    ),
  cooldown: 2,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "key") return interaction.respond([]);

    const typed = focused.value.trim();
    const needle = typed.toLowerCase();
    const paths = listPaths(currentEnv());

    const starts = paths.filter((p) => p.toLowerCase().startsWith(needle));
    const contains = paths.filter((p) => !starts.includes(p) && p.toLowerCase().includes(needle));
    const choices = [...starts, ...contains];

    // Offer the typed path itself so `set` can create a key that doesn't exist yet.
    if (typed && !paths.includes(typed) && PATH_PATTERN.test(typed)) choices.unshift(typed);

    await interaction.respond(choices.slice(0, 25).map((p) => ({ name: p, value: p })));
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    try {
      if (sub === "view") {
        const env = (await refreshEnv(interaction.client)) ?? currentEnv();
        await replyWithDump(interaction, "🗄️ **Current env**", JSON.stringify(env, null, 2), "env.json");
        return;
      }

      const key = interaction.options.getString("key", true).trim();
      const problem = validatePath(key);
      if (problem) {
        await interaction.editReply(`❌ ${problem}`);
        return;
      }

      if (sub === "get") {
        const env = (await refreshEnv(interaction.client)) ?? currentEnv();
        const value = getPath(env, key);
        if (value === undefined) {
          await interaction.editReply(`ℹ️ \`${key}\` isn't set.`);
          return;
        }
        await replyWithDump(interaction, `🗄️ \`${key}\``, formatEnvValue(value), `${key}.json`);
        return;
      }

      if (sub === "set") {
        let value;
        try {
          value = parseEnvValue(interaction.options.getString("value", true));
        } catch (err) {
          await interaction.editReply(`❌ ${err.message}`);
          return;
        }
        const next = await setEnvValue(interaction.client, key, value);
        await replyWithDump(interaction, `✅ \`${key}\` set to`, formatEnvValue(getPath(next, key)), `${key}.json`);
        return;
      }

      if (sub === "delete") {
        const before = getPath(currentEnv(), key);
        if (before === undefined) {
          await interaction.editReply(`ℹ️ \`${key}\` isn't set.`);
          return;
        }
        await deleteEnvValue(interaction.client, key);
        await interaction.editReply(`✅ Removed \`${key}\`.`);
      }
    } catch (err) {
      console.error("💥 [chappelly] /env failed:", err);
      await interaction.editReply("❌ Failed to update the env.");
    }
  },
};

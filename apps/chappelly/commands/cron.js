import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ChannelType,
} from "discord.js";
import { currentEnv, writeEnv, setPath, deletePath, recordCronRun } from "../env.js";
import {
  parseTimes,
  parseDays,
  daysToLabel,
  timesToLabel,
  normalizeEveryDays,
  addDays,
} from "../schedule.js";
import { resolveChannelId, resolveMentions } from "../jobs/common.js";
import { runJob, jobTypeOf, JOB_TYPES, DEFAULT_JOB } from "../jobs/registry.js";
import { toEstDateString } from "../../../util/dateUtils.js";

/**
 * Form-driven editing of env.crons. A modal holds at most five text inputs, so
 * the cron's id, channel, interval and job type travel as slash options (and
 * ride along in the modal's customId), and the modal itself takes times, days,
 * message, mentions and either a button label or — for a weather cron — the
 * place to forecast. The gif has its own subcommand since swapping it is the
 * common edit. Anything the form can't express is one
 * `/env set crons.<id>.<field>` away.
 */

export const MODAL_PREFIX = "cron-modal:";
// Ids are one path segment (see PATH_PATTERN in env.js) and must fit a 100-char
// customId next to the prefix, a channel snowflake and the interval.
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const NONE = "-";
const URL_PATTERN = /^https?:\/\/\S+$/i;

const idOption = (opt) =>
  opt.setName("id").setDescription("Cron id, e.g. neema-pill").setRequired(true).setAutocomplete(true);

const channelOption = (opt) =>
  opt
    .setName("channel")
    .setDescription("Where the reminder posts (defaults to REMINDER_CHANNEL_ID)")
    .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread)
    .setRequired(false);

const everyDaysOption = (opt) =>
  opt
    .setName("every_days")
    .setDescription("Only post once every N days (0 = every scheduled day)")
    .setMinValue(0)
    .setMaxValue(365)
    .setRequired(false);

const jobOption = (opt) =>
  opt
    .setName("job")
    .setDescription("What this cron posts (default: reminder)")
    .addChoices(...JOB_TYPES.map((type) => ({ name: type, value: type })))
    .setRequired(false);

function buildCronModal(id, cron, channelId, everyDays, job) {
  const field = (customId, label, value, { required = true, style = TextInputStyle.Short, placeholder } = {}) => {
    const input = new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(style)
      .setValue(value ?? "")
      .setRequired(required);
    if (placeholder) input.setPlaceholder(placeholder);
    return new ActionRowBuilder().addComponents(input);
  };

  const weather = job === "weather";

  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${id}:${channelId || NONE}:${everyDays ?? NONE}:${job}`)
    .setTitle(`Cron: ${id}`.slice(0, 45))
    .addComponents(
      field("times", "Times (24h ET, comma-separated)", timesToLabel(cron?.times), { placeholder: "06:00, 18:00" }),
      field("days", "Days (daily, weekdays, Mon,Wed or 0,3)", cron ? daysToLabel(cron.days) : "daily"),
      field(
        "message",
        weather ? "Line above the forecast (optional)" : "Message (optional if the cron has a gif)",
        cron?.message,
        { style: TextInputStyle.Paragraph, required: false },
      ),
      field("mentions", "Mentions (env keys or user ids, comma-sep)", (cron?.mentions ?? ["KING_USER_ID", "QUEEN_USER_ID"]).join(", "), { required: false }),
      // A weather post has nothing to confirm, so its fifth input (five is the
      // modal cap) is the place to forecast rather than a button label.
      weather
        ? field("location", "Location (blank = WEATHER_LOCATION)", cron?.location, { required: false, placeholder: "Rock Hill, SC" })
        : field("button", "Button label (blank = no button)", cron?.button ?? "YES", { required: false }),
    );
}

function describeCron(env, id, cron) {
  const channelId = resolveChannelId(env, cron);
  const mentions = resolveMentions(env, cron);
  const everyDays = normalizeEveryDays(cron.everyDays);
  const job = jobTypeOf(cron);
  const lines = [
    `**${id}** ${cron.enabled === false ? "⏸️ (disabled)" : "▶️"}${job === DEFAULT_JOB ? "" : ` — *${job}*`}`,
    `• ${timesToLabel(cron.times) || "—"} ET, ${daysToLabel(cron.days)}`,
  ];
  if (everyDays) {
    const next = addDays(cron.lastRun, everyDays);
    lines.push(`• every ${everyDays} days — last ${cron.lastRun ?? "never"}, next ${next ?? "at the next slot"}`);
  }
  lines.push(
    `• channel: ${channelId ? `<#${channelId}>` : "— (unset)"}`,
    `• mentions: ${mentions.length ? mentions.map((uid) => `<@${uid}>`).join(" ") : "— (unresolved)"}`,
  );
  if (job === "weather") {
    lines.push(`• location: ${cron.location || env.WEATHER_LOCATION || "— (set WEATHER_LOCATION)"}`);
  } else {
    lines.push(`• button: ${cron.button ? `\`${cron.button}\`` : "none"}`);
  }
  if (cron.message) lines.push(`• ${cron.message}`);
  if (cron.gif) lines.push(`• gif: <${cron.gif}>`);
  return lines.join("\n");
}

/**
 * Handle the /cron add|edit modal. Wired up in index.js's InteractionCreate
 * listener since modal submits aren't routed through client.commands.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
export async function handleCronModalSubmit(interaction) {
  if (!interaction.customId.startsWith(MODAL_PREFIX)) return;
  const [id, channelToken, everyDaysToken, jobToken] = interaction.customId.slice(MODAL_PREFIX.length).split(":");
  const job = JOB_TYPES.includes(jobToken) ? jobToken : DEFAULT_JOB;
  const weather = job === "weather";

  await interaction.deferReply({ ephemeral: true });

  const times = parseTimes(interaction.fields.getTextInputValue("times"));
  if (!times) {
    await interaction.editReply("❌ Invalid times. Use 24h HH:mm, comma-separated, e.g. `06:00, 18:00`.");
    return;
  }
  const days = parseDays(interaction.fields.getTextInputValue("days"));
  if (!days) {
    await interaction.editReply("❌ Invalid days. Use `daily`, `weekdays`, `weekends`, day names or 0–6, e.g. `Mon,Wed`.");
    return;
  }
  const message = interaction.fields.getTextInputValue("message").trim();
  const mentions = interaction.fields.getTextInputValue("mentions")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  // A weather cron traded the button input for a location (see buildCronModal).
  const button = weather ? "" : interaction.fields.getTextInputValue("button").trim();
  const location = weather ? interaction.fields.getTextInputValue("location").trim() : null;

  const existing = currentEnv().crons?.[id];
  // A weather cron always has a forecast to post; a reminder needs words or a gif.
  if (!weather && !message && !existing?.gif) {
    await interaction.editReply("❌ The message can't be empty unless the cron has a gif (`/cron gif`).");
    return;
  }

  // Options given on the slash command win; otherwise keep what the cron had.
  const everyDays = everyDaysToken !== NONE
    ? normalizeEveryDays(everyDaysToken)
    : normalizeEveryDays(existing?.everyDays);

  const record = {
    ...existing,
    enabled: existing?.enabled ?? true,
    job,
    times,
    days,
    channel: channelToken !== NONE ? channelToken : (existing?.channel ?? ""),
    message,
    gif: existing?.gif ?? "",
    mentions,
    button,
  };
  if (weather) record.location = location;
  else delete record.location;
  if (everyDays) {
    record.everyDays = everyDays;
    // A cron that just became an interval counts today as its last run, so
    // it first posts a full interval from now rather than at the next slot.
    record.lastRun = existing?.lastRun ?? toEstDateString(new Date());
  } else {
    delete record.everyDays;
    delete record.lastRun;
  }

  const next = await writeEnv(
    interaction.client,
    (env) => setPath(env, `crons.${id}`, record),
    `🗄️ Env updated — cron \`${id}\` ${existing ? "edited" : "added"}`,
  );
  await interaction.editReply({
    content: `✅ Cron ${existing ? "updated" : "added"}.\n${describeCron(next, id, next.crons[id])}`,
    allowedMentions: { parse: [] },
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName("cron")
    .setDescription("Manage the bot's scheduled reminders (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) => sub.setName("list").setDescription("Show every cron"))
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Create a cron (opens a form)")
        .addStringOption((opt) => opt.setName("id").setDescription("New id, e.g. neema-pill").setRequired(true))
        .addChannelOption(channelOption)
        .addIntegerOption(everyDaysOption)
        .addStringOption(jobOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Edit a cron (opens a pre-filled form)")
        .addStringOption(idOption)
        .addChannelOption(channelOption)
        .addIntegerOption(everyDaysOption)
        .addStringOption(jobOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("gif")
        .setDescription("Change (or clear) the gif a cron posts")
        .addStringOption(idOption)
        .addStringOption((opt) => opt.setName("url").setDescription("Gif URL — leave out to clear").setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("reset")
        .setDescription("Restart an every-N-days cron's countdown from today")
        .addStringOption(idOption),
    )
    .addSubcommand((sub) => sub.setName("remove").setDescription("Delete a cron").addStringOption(idOption))
    .addSubcommand((sub) => sub.setName("enable").setDescription("Resume a paused cron").addStringOption(idOption))
    .addSubcommand((sub) => sub.setName("disable").setDescription("Pause a cron without deleting it").addStringOption(idOption))
    .addSubcommand((sub) => sub.setName("run").setDescription("Fire a cron right now (test)").addStringOption(idOption)),
  cooldown: 2,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "id") return interaction.respond([]);
    const needle = focused.value.trim().toLowerCase();
    const ids = Object.keys(currentEnv().crons ?? {}).filter((id) => id.toLowerCase().includes(needle));
    await interaction.respond(ids.slice(0, 25).map((id) => ({ name: id, value: id })));
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // add/edit open a modal, which must be the interaction's first response —
    // so their checks run against the cached env, no await before showModal().
    if (sub === "add" || sub === "edit") {
      const id = interaction.options.getString("id", true).trim().toLowerCase();
      const channelId = interaction.options.getChannel("channel")?.id ?? "";
      const everyDays = interaction.options.getInteger("every_days");
      const existing = currentEnv().crons?.[id];
      // The option wins when given; otherwise the cron stays what it already is.
      const job = interaction.options.getString("job") ?? jobTypeOf(existing);

      if (!ID_PATTERN.test(id)) {
        await interaction.reply({ content: "❌ Ids are 1–32 lowercase letters, digits, `-` or `_`, e.g. `neema-pill`.", ephemeral: true });
        return;
      }
      if (sub === "add" && existing) {
        await interaction.reply({ content: `❌ \`${id}\` already exists — use \`/cron edit\`.`, ephemeral: true });
        return;
      }
      if (sub === "edit" && !existing) {
        await interaction.reply({ content: `❌ No cron called \`${id}\`.`, ephemeral: true });
        return;
      }

      await interaction.showModal(buildCronModal(id, existing, channelId, everyDays, job));
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const env = currentEnv();

      if (sub === "list") {
        const entries = Object.entries(env.crons ?? {});
        if (entries.length === 0) {
          await interaction.editReply("ℹ️ No crons yet — `/cron add` to create one.");
          return;
        }
        await interaction.editReply({
          content: entries.map(([id, cron]) => describeCron(env, id, cron)).join("\n\n"),
          allowedMentions: { parse: [] },
        });
        return;
      }

      const id = interaction.options.getString("id", true).trim();
      const cron = env.crons?.[id];
      if (!cron) {
        await interaction.editReply(`❌ No cron called \`${id}\`.`);
        return;
      }

      if (sub === "remove") {
        await writeEnv(interaction.client, (e) => deletePath(e, `crons.${id}`).next, `🗄️ Env updated — cron \`${id}\` removed`);
        await interaction.editReply(`✅ Removed cron \`${id}\`.`);
        return;
      }

      if (sub === "gif") {
        const url = interaction.options.getString("url")?.trim() ?? "";
        if (url && !URL_PATTERN.test(url)) {
          await interaction.editReply("❌ That doesn't look like a URL.");
          return;
        }
        if (!url && !cron.message) {
          await interaction.editReply("❌ Can't clear the gif — this cron has no message, so it would post nothing.");
          return;
        }
        await writeEnv(interaction.client, (e) => setPath(e, `crons.${id}.gif`, url), `🗄️ Env updated — cron \`${id}\` gif`);
        await interaction.editReply(url ? `✅ Cron \`${id}\` now posts <${url}>` : `✅ Cleared the gif on \`${id}\`.`);
        return;
      }

      if (sub === "reset") {
        const everyDays = normalizeEveryDays(cron.everyDays);
        if (!everyDays) {
          await interaction.editReply(`❌ \`${id}\` isn't an every-N-days cron — set one with \`/cron edit id every_days:3\`.`);
          return;
        }
        const today = toEstDateString(new Date());
        const next = await recordCronRun(interaction.client, id, today, `🗄️ Env updated — cron \`${id}\` reset`);
        await interaction.editReply(
          next
            ? `✅ Timer reset. \`${id}\` next posts **${addDays(today, everyDays)}** at ${timesToLabel(cron.times)} ET.`
            : "❌ Couldn't write the reset — check the logs.",
        );
        return;
      }

      if (sub === "enable" || sub === "disable") {
        const enabled = sub === "enable";
        await writeEnv(interaction.client, (e) => setPath(e, `crons.${id}.enabled`, enabled), `🗄️ Env updated — cron \`${id}\` ${sub}d`);
        await interaction.editReply(`✅ Cron \`${id}\` ${enabled ? "enabled" : "disabled"}.`);
        return;
      }

      if (sub === "run") {
        // Test fire: ignores an interval gate and doesn't stamp lastRun. A job
        // that throws — a weather cron whose location won't resolve, say — says
        // why here rather than falling through to the generic failure below.
        let posted;
        try {
          posted = await runJob({ client: interaction.client }, id, cron, { force: true });
        } catch (err) {
          console.error(`💥 [chappelly] /cron run \`${id}\` failed:`, err);
          await interaction.editReply(`❌ \`${id}\` failed: ${err.message}`);
          return;
        }
        await interaction.editReply(
          posted
            ? `✅ Fired \`${id}\`: ${posted.url}${normalizeEveryDays(cron.everyDays) ? " (test run — the every-N-days timer is untouched)" : ""}`
            : `⚠️ \`${id}\` didn't post — check the channel / REMINDER_CHANNEL_ID (see logs).`,
        );
      }
    } catch (err) {
      console.error("💥 [chappelly] /cron failed:", err);
      await interaction.editReply("❌ Failed to update crons.");
    }
  },
};

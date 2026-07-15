import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from "discord.js";
import { getDb, updateDb, defaultDb } from "../db.js";

const MODAL_PREFIX = "config-modal:";
const DAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DAY_NAMES = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

function parseDays(input) {
  const tokens = input.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
  const days = new Set();
  for (const token of tokens) {
    if (/^[0-6]$/.test(token)) {
      days.add(Number(token));
      continue;
    }
    if (!(token in DAY_NAMES)) return null;
    days.add(DAY_NAMES[token]);
  }
  return days.size ? [...days].sort((a, b) => a - b) : null;
}

function parseHHmm(input) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(input.trim());
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function parseYYYYMMDD(input) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
  return `${year}-${month}-${day}`;
}

function daysToLabel(days) {
  return (days ?? []).map(d => DAY_SHORT_NAMES[d] ?? d).join(",");
}

function pauseToLabel(pause) {
  return pause?.start && pause?.end ? `${pause.start} – ${pause.end}` : "—";
}

function buildGiftRotationModal(current) {
  const giftRotation = current.giftRotation ?? defaultDb().giftRotation;

  const daysInput = new TextInputBuilder()
    .setCustomId("days")
    .setLabel("Days (e.g. Sun,Wed or 0,3)")
    .setStyle(TextInputStyle.Short)
    .setValue(daysToLabel(giftRotation.days))
    .setRequired(true);

  const timeInput = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("Time (24h ET, e.g. 19:30)")
    .setStyle(TextInputStyle.Short)
    .setValue(giftRotation.time ?? "")
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}gift-rotation`)
    .setTitle("Gift Rotation Schedule")
    .addComponents(
      new ActionRowBuilder().addComponents(daysInput),
      new ActionRowBuilder().addComponents(timeInput),
    );
}

function buildDailyPostModal(current) {
  const dailyPost = current.dailyPost ?? defaultDb().dailyPost;

  const startInput = new TextInputBuilder()
    .setCustomId("windowStart")
    .setLabel("Window start (24h ET, e.g. 19:30)")
    .setStyle(TextInputStyle.Short)
    .setValue(dailyPost.windowStartTime ?? "")
    .setRequired(true);

  const endInput = new TextInputBuilder()
    .setCustomId("windowEnd")
    .setLabel("Window end, next day (24h ET)")
    .setStyle(TextInputStyle.Short)
    .setValue(dailyPost.windowEndTime ?? "")
    .setRequired(true);

  const retryInput = new TextInputBuilder()
    .setCustomId("retryInterval")
    .setLabel("Retry interval (minutes)")
    .setStyle(TextInputStyle.Short)
    .setValue(String(dailyPost.retryIntervalMinutes ?? ""))
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}daily-post`)
    .setTitle("Daily Post Schedule")
    .addComponents(
      new ActionRowBuilder().addComponents(startInput),
      new ActionRowBuilder().addComponents(endInput),
      new ActionRowBuilder().addComponents(retryInput),
    );
}

function buildPauseModal(current) {
  const pause = current.giftRotation?.pause;

  const startInput = new TextInputBuilder()
    .setCustomId("start")
    .setLabel("Pause start date (YYYY-MM-DD)")
    .setStyle(TextInputStyle.Short)
    .setValue(pause?.start ?? "")
    .setPlaceholder("Leave both blank to clear the pause")
    .setRequired(false);

  const endInput = new TextInputBuilder()
    .setCustomId("end")
    .setLabel("Pause end date (YYYY-MM-DD, inclusive)")
    .setStyle(TextInputStyle.Short)
    .setValue(pause?.end ?? "")
    .setPlaceholder("Leave both blank to clear the pause")
    .setRequired(false);

  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}gift-rotation-pause`)
    .setTitle("Gift Rotation Pause Window")
    .addComponents(
      new ActionRowBuilder().addComponents(startInput),
      new ActionRowBuilder().addComponents(endInput),
    );
}

/**
 * Handle the modal submissions produced by the "gift-rotation", "daily-post",
 * and "pause" subcommands. Wired up in index.js's InteractionCreate listener
 * since modal submits aren't routed through client.commands.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
export async function handleConfigModalSubmit(interaction) {
  if (!interaction.customId.startsWith(MODAL_PREFIX)) return;
  const kind = interaction.customId.slice(MODAL_PREFIX.length);

  await interaction.deferReply({ ephemeral: true });
  const current = (await getDb(interaction.client)) ?? defaultDb();

  if (kind === "gift-rotation") {
    const days = parseDays(interaction.fields.getTextInputValue("days"));
    if (!days) {
      await interaction.editReply('❌ Invalid days. Use day names or numbers, e.g. "Sun,Wed" or "0,3".');
      return;
    }
    const time = parseHHmm(interaction.fields.getTextInputValue("time"));
    if (!time) {
      await interaction.editReply("❌ Invalid time. Use 24h HH:mm, e.g. 19:30.");
      return;
    }

    const newDb = await updateDb(interaction.client, {
      giftRotation: { ...(current.giftRotation ?? defaultDb().giftRotation), days, time },
    });
    await interaction.editReply(
      `✅ Gift rotation now runs on **${daysToLabel(newDb.giftRotation.days)}** at **${newDb.giftRotation.time}** ET.`
    );
    return;
  }

  if (kind === "daily-post") {
    const windowStartTime = parseHHmm(interaction.fields.getTextInputValue("windowStart"));
    if (!windowStartTime) {
      await interaction.editReply("❌ Invalid window start. Use 24h HH:mm, e.g. 19:30.");
      return;
    }
    const windowEndTime = parseHHmm(interaction.fields.getTextInputValue("windowEnd"));
    if (!windowEndTime) {
      await interaction.editReply("❌ Invalid window end. Use 24h HH:mm, e.g. 15:30.");
      return;
    }
    const retryRaw = interaction.fields.getTextInputValue("retryInterval").trim();
    const retryIntervalMinutes = Number(retryRaw);
    if (!Number.isInteger(retryIntervalMinutes) || retryIntervalMinutes < 1 || retryIntervalMinutes > 1440) {
      await interaction.editReply("❌ Invalid retry interval. Use a whole number of minutes (1–1440).");
      return;
    }

    const newDb = await updateDb(interaction.client, {
      dailyPost: { ...(current.dailyPost ?? defaultDb().dailyPost), windowStartTime, windowEndTime, retryIntervalMinutes },
    });
    await interaction.editReply(
      `✅ Daily post window now **${newDb.dailyPost.windowStartTime}–${newDb.dailyPost.windowEndTime}** ET, retrying every **${newDb.dailyPost.retryIntervalMinutes}** min.`
    );
    return;
  }

  if (kind === "gift-rotation-pause") {
    const startRaw = interaction.fields.getTextInputValue("start").trim();
    const endRaw = interaction.fields.getTextInputValue("end").trim();

    if (!startRaw && !endRaw) {
      await updateDb(interaction.client, {
        giftRotation: { ...(current.giftRotation ?? defaultDb().giftRotation), pause: null },
      });
      await interaction.editReply("✅ Gift rotation pause cleared.");
      return;
    }

    if (!startRaw || !endRaw) {
      await interaction.editReply("❌ Provide both a start and end date, or leave both blank to clear the pause.");
      return;
    }

    const start = parseYYYYMMDD(startRaw);
    const end = parseYYYYMMDD(endRaw);
    if (!start || !end) {
      await interaction.editReply("❌ Invalid date. Use YYYY-MM-DD, e.g. 2026-04-06.");
      return;
    }
    if (start > end) {
      await interaction.editReply("❌ Start date must be on or before the end date.");
      return;
    }

    const newDb = await updateDb(interaction.client, {
      giftRotation: { ...(current.giftRotation ?? defaultDb().giftRotation), pause: { start, end } },
    });
    await interaction.editReply(`✅ Gift rotation now paused **${newDb.giftRotation.pause.start} – ${newDb.giftRotation.pause.end}** ET.`);
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("View or change the bot's schedule config (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub
        .setName("view")
        .setDescription("Show the current config")
    )
    .addSubcommand(sub =>
      sub
        .setName("gift-rotation")
        .setDescription("Change when gift rotations happen")
    )
    .addSubcommand(sub =>
      sub
        .setName("daily-post")
        .setDescription("Change the daily event post schedule")
    )
    .addSubcommand(sub =>
      sub
        .setName("pause")
        .setDescription("Set or clear a date range that pauses gift rotation")
    )
    .addSubcommand(sub =>
      sub
        .setName("add-gif")
        .setDescription("Add a gif to the gift rotation announcement pool")
        .addStringOption(opt =>
          opt
            .setName("url")
            .setDescription("Gif URL")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("remove-gif")
        .setDescription("Remove a gif from the gift rotation announcement pool")
        .addStringOption(opt =>
          opt
            .setName("url")
            .setDescription("Gif URL")
            .setRequired(true)
        )
    ),
  cooldown: 3,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // These open a pre-filled modal instead of a deferred reply — showModal()
    // must be the interaction's first response.
    if (sub === "gift-rotation" || sub === "daily-post" || sub === "pause") {
      const current = (await getDb(interaction.client)) ?? defaultDb();
      const modal = sub === "gift-rotation"
        ? buildGiftRotationModal(current)
        : sub === "daily-post"
          ? buildDailyPostModal(current)
          : buildPauseModal(current);
      await interaction.showModal(modal);
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const current = (await getDb(interaction.client)) ?? defaultDb();

      if (sub === "view") {
        const lines = [
          "🗄️ **Current Config**",
          "",
          `**Gift rotation days:** ${daysToLabel(current.giftRotation?.days) || "—"}`,
          `**Gift rotation time:** ${current.giftRotation?.time ?? "—"} ET`,
          `**Gift rotation pause:** ${pauseToLabel(current.giftRotation?.pause)}`,
          `**Gift rotation gifs (${(current.giftRotation?.gifs ?? []).length}):**`,
          ...((current.giftRotation?.gifs ?? []).map(g => `• ${g}`)),
          "",
          `**Daily post window start:** ${current.dailyPost?.windowStartTime ?? "—"} ET`,
          `**Daily post window end:** ${current.dailyPost?.windowEndTime ?? "—"} ET`,
          `**Daily post retry interval:** ${current.dailyPost?.retryIntervalMinutes ?? "—"} min`,
        ];
        await interaction.editReply(lines.join("\n"));
        return;
      }

      if (sub === "add-gif") {
        const url = interaction.options.getString("url", true).trim();
        const gifs = current.giftRotation?.gifs ?? [];

        if (gifs.includes(url)) {
          await interaction.editReply("ℹ️ That gif is already in the pool.");
          return;
        }

        const newDb = await updateDb(interaction.client, {
          giftRotation: { ...(current.giftRotation ?? defaultDb().giftRotation), gifs: [...gifs, url] },
        });
        await interaction.editReply(`✅ Added. Gift pool now has **${newDb.giftRotation.gifs.length}** gif(s).`);
        return;
      }

      if (sub === "remove-gif") {
        const url = interaction.options.getString("url", true).trim();
        const gifs = current.giftRotation?.gifs ?? [];

        if (!gifs.includes(url)) {
          await interaction.editReply("ℹ️ That gif isn't in the pool.");
          return;
        }

        const newDb = await updateDb(interaction.client, {
          giftRotation: { ...(current.giftRotation ?? defaultDb().giftRotation), gifs: gifs.filter(g => g !== url) },
        });
        await interaction.editReply(`✅ Removed. Gift pool now has **${newDb.giftRotation.gifs.length}** gif(s).`);
        return;
      }
    } catch (err) {
      console.error("💥 Config command failed:", err);
      await interaction.editReply("❌ Failed to update config.");
    }
  },
};

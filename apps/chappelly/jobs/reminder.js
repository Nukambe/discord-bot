import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { currentEnv, recordCronRun } from "../env.js";
import { normalizeEveryDays, daysBetween } from "../schedule.js";
import { toEstDateString } from "../../../util/dateUtils.js";

/**
 * The "reminder" cron: post a message (and/or a gif) mentioning some people,
 * optionally with a single confirmation button one of them presses to mark it
 * done. Every cron entry under env.crons is one of these (see defaultEnv in
 * env.js for the shape).
 *
 * A cron with `everyDays` is an interval: its scheduler slot still fires at
 * every configured time, but the post is gated on `everyDays` days having
 * passed since `lastRun`, and each post stamps lastRun with today. Gating on
 * "days since the last post" rather than a fixed modulus means a missed day
 * (bot down at 8am) posts at the next slot instead of waiting a whole cycle,
 * and /cron reset is just "stamp lastRun with today".
 *
 * The button's customId only carries the cron id — who may press it and what
 * "done" looks like are resolved from the live env at click time — so a
 * reminder posted before a restart (or before an env edit) still works.
 */

export const BUTTON_PREFIX = "reminder-done:";
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * A cron's `mentions` are env key names (KING_USER_ID) or raw user ids. Keys
 * whose env value is empty are dropped rather than mentioned as literal text.
 */
export function resolveMentions(env, cron) {
  const ids = (cron?.mentions ?? []).map((m) => {
    const viaEnv = env?.[m];
    return typeof viaEnv === "string" && viaEnv.trim() ? viaEnv.trim() : String(m).trim();
  });
  return [...new Set(ids.filter((id) => SNOWFLAKE.test(id)))];
}

export const resolveChannelId = (env, cron) =>
  String(cron?.channel || env?.REMINDER_CHANNEL_ID || "").trim();

/**
 * Post the reminder for cron `id`. Reads the cron from the cached live env
 * rather than the scheduler's ctx snapshot, because an interval cron's own
 * lastRun stamp is written silently (no schedule rebuild) and must be seen
 * by the very next slot.
 *
 * `force` (the manual /cron run) bypasses the interval gate and does not stamp
 * lastRun, so a test post never shifts the real cadence.
 * @returns {Promise<import('discord.js').Message|null>} the posted message, or null if skipped
 */
export async function runReminder({ client }, id, { force = false } = {}) {
  const env = currentEnv();
  const cron = env.crons?.[id];
  if (!cron) {
    console.warn(`⚠️ [chappelly] Cron "${id}" no longer exists, skipping.`);
    return null;
  }

  const everyDays = normalizeEveryDays(cron.everyDays);
  const today = toEstDateString(new Date());
  if (everyDays && !force) {
    const since = daysBetween(cron.lastRun, today);
    if (since !== null && since < everyDays) {
      console.log(`⏭️ [chappelly] Cron "${id}": ${since}/${everyDays} day(s) since ${cron.lastRun}, not yet.`);
      return null;
    }
  }

  const channelId = resolveChannelId(env, cron);
  if (!channelId) {
    console.warn(`⚠️ [chappelly] Cron "${id}" has no channel and REMINDER_CHANNEL_ID is unset, skipping.`);
    return null;
  }
  const channel = client.channels.cache.get(channelId)
    ?? await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    console.error(`💥 [chappelly] Cron "${id}": channel ${channelId} not found or not text-based.`);
    return null;
  }

  const mentions = resolveMentions(env, cron);
  if (mentions.length === 0) {
    console.warn(`⚠️ [chappelly] Cron "${id}" resolves to no mentions (KING_USER_ID/QUEEN_USER_ID unset?), posting anyway.`);
  }

  const firstLine = [mentions.map((uid) => `<@${uid}>`).join(" "), String(cron.message ?? "").trim()]
    .filter(Boolean)
    .join(" ");
  // The gif goes on its own line so Discord unfurls it under the text.
  const content = [firstLine, String(cron.gif ?? "").trim()].filter(Boolean).join("\n");
  if (!content) {
    console.warn(`⚠️ [chappelly] Cron "${id}" has no message, gif or mentions — nothing to post.`);
    return null;
  }

  const label = String(cron.button ?? "").trim();
  const components = label
    ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${BUTTON_PREFIX}${id}`)
          .setLabel(label.slice(0, 80))
          .setStyle(ButtonStyle.Success),
      )]
    : [];

  const message = await channel.send({ content, components });
  console.log(`📣 [chappelly] Posted reminder "${id}" to #${channel.name ?? channelId}`);
  if (everyDays && !force) await recordCronRun(client, id, today);
  return message;
}

/**
 * Button press on a reminder. Only the people the cron mentions may confirm;
 * confirming removes the button and stamps who did it and when.
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleReminderButton(interaction) {
  const id = interaction.customId.slice(BUTTON_PREFIX.length);
  const env = currentEnv();
  const cron = env.crons?.[id];

  // A cron that has since been deleted can still be confirmed by whoever the
  // env currently names, so old reminders don't get stuck with a dead button.
  const allowed = cron
    ? resolveMentions(env, cron)
    : [env.KING_USER_ID, env.QUEEN_USER_ID].filter((v) => typeof v === "string" && v.trim());

  if (allowed.length && !allowed.includes(interaction.user.id)) {
    await interaction.reply({
      content: `⛔ Only ${allowed.map((uid) => `<@${uid}>`).join(" or ")} can confirm this one.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const stamp = `<t:${Math.floor(Date.now() / 1000)}:t>`;
  const label = interaction.component?.label ?? "Done";
  await interaction.update({
    content: `${interaction.message.content}\n✅ **${label}** — <@${interaction.user.id}> at ${stamp}`,
    components: [],
    allowedMentions: { parse: [] },
  });
  console.log(`✅ [chappelly] Reminder "${id}" confirmed by ${interaction.user.tag}`);
}

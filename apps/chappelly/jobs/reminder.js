import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { currentEnv, recordCronRun } from "../env.js";
import { prepareRun, resolveChannel, resolveMentions, mentionLine } from "./common.js";

/**
 * The "reminder" cron — the default job type: post a message (and/or a gif)
 * mentioning some people, optionally with a single confirmation button one of
 * them presses to mark it done. A cron entry under env.crons is one of these
 * unless its `job` says otherwise (see jobs/weather.js).
 *
 * A cron with `everyDays` is an interval: its scheduler slot still fires at
 * every configured time, but the post is gated on `everyDays` days having
 * passed since `lastRun` (see prepareRun), and each post stamps lastRun with
 * today. Gating on "days since the last post" rather than a fixed modulus
 * means a missed day (bot down at 8am) posts at the next slot instead of
 * waiting a whole cycle, and /cron reset is just "stamp lastRun with today".
 *
 * The button's customId only carries the cron id — who may press it and what
 * "done" looks like are resolved from the live env at click time — so a
 * reminder posted before a restart (or before an env edit) still works.
 */

export const BUTTON_PREFIX = "reminder-done:";

/**
 * Post the reminder for cron `id`.
 *
 * `force` (the manual /cron run) bypasses the interval gate and does not stamp
 * lastRun, so a test post never shifts the real cadence.
 * @returns {Promise<import('discord.js').Message|null>} the posted message, or null if skipped
 */
export async function runReminder({ client }, id, { force = false } = {}) {
  const prepared = prepareRun(id, { force });
  if (!prepared) return null;
  const { env, cron, today, everyDays } = prepared;

  const channel = await resolveChannel(client, env, cron, id);
  if (!channel) return null;

  const mentions = resolveMentions(env, cron);
  if (mentions.length === 0) {
    console.warn(`⚠️ [chappelly] Cron "${id}" resolves to no mentions (KING_USER_ID/QUEEN_USER_ID unset?), posting anyway.`);
  }

  const firstLine = [mentionLine(mentions), String(cron.message ?? "").trim()]
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
  console.log(`📣 [chappelly] Posted reminder "${id}" to #${channel.name ?? channel.id}`);
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

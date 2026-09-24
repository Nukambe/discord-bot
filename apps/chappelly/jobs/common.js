import { currentEnv } from "../env.js";
import { intervalStatus } from "../schedule.js";
import { toEstDateString } from "../../../util/dateUtils.js";

/**
 * The bits every cron job shares, whatever it posts: where it posts, who it
 * mentions, and whether an `everyDays` cron is due yet. Split out of
 * reminder.js once weather.js needed the same four answers.
 */

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

export const mentionLine = (ids) => ids.map((uid) => `<@${uid}>`).join(" ");

/**
 * Resolve a cron's destination channel, logging (rather than throwing) every
 * way it can come up empty — a cron pointed at a deleted channel must not take
 * the rest of the slot's jobs down with it.
 * @returns {Promise<import('discord.js').TextBasedChannel|null>}
 */
export async function resolveChannel(client, env, cron, id) {
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
  return channel;
}

/**
 * Load cron `id` from the cached live env and decide whether this slot should
 * post. The live env is read rather than the scheduler's ctx snapshot because
 * an interval cron's own `lastRun` stamp is written silently (no schedule
 * rebuild) and has to be visible to the very next slot.
 *
 * `force` (the manual /cron run) skips the interval gate; the caller is then
 * responsible for *not* stamping lastRun, so a test post can't shift the
 * real cadence.
 * @returns {{ env: object, cron: object, today: string, everyDays: number|null }|null}
 */
export function prepareRun(id, { force = false } = {}) {
  const env = currentEnv();
  const cron = env.crons?.[id];
  if (!cron) {
    console.warn(`⚠️ [chappelly] Cron "${id}" no longer exists, skipping.`);
    return null;
  }

  const today = toEstDateString(new Date());
  const { everyDays, since, due } = intervalStatus(cron, today);
  if (!force && !due) {
    console.log(`⏭️ [chappelly] Cron "${id}": ${since}/${everyDays} day(s) since ${cron.lastRun}, not yet.`);
    return null;
  }

  return { env, cron, today, everyDays };
}

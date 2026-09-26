import { runReminder } from "./reminder.js";
import { runWeather } from "./weather.js";
import { runNews } from "./news.js";

/**
 * What kinds of post a cron entry can be. An entry's `job` field names one of
 * these; leaving it unset means "reminder", which is what every cron written
 * before job types existed is.
 *
 * Adding a kind means writing a `run(ctx, id, { force })` module and listing it
 * here — index.js, the scheduler and /cron all go through this map, so none of
 * them need to know the kinds apart.
 */

export const DEFAULT_JOB = "reminder";

export const JOB_RUNNERS = {
  reminder: runReminder,
  weather: runWeather,
  news: runNews,
};

export const JOB_TYPES = Object.keys(JOB_RUNNERS);

/** A cron's job type, falling back to the default for an unset or unknown one. */
export function jobTypeOf(cron) {
  const type = String(cron?.job ?? "").trim().toLowerCase();
  if (!type) return DEFAULT_JOB;
  if (!(type in JOB_RUNNERS)) {
    console.warn(`⚠️ [chappelly] Unknown job type "${type}" — running it as a ${DEFAULT_JOB}.`);
    return DEFAULT_JOB;
  }
  return type;
}

/** Run cron `id` with whichever job its entry names. */
export const runJob = (ctx, id, cron, options) => JOB_RUNNERS[jobTypeOf(cron)](ctx, id, options);

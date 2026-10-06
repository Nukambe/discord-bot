import { EmbedBuilder } from "discord.js";
import { currentEnv, writeEnv, setPath, recordCronRun } from "../env.js";
import { prepareRun, resolveChannel, resolveMentions, mentionLine } from "./common.js";
import { atTime } from "../cronScheduler.js";
import { parseHHmm } from "../schedule.js";
import { getSchedule, formatStartTime, DEFAULT_SOURCE } from "../streams.js";
import { toEstDateString } from "../../../util/dateUtils.js";

/**
 * The "streams" cron (`job: "streams"` on an env.crons entry): once a day,
 * read a methstreams league schedule (`source`, NBA by default — see
 * ../streams.js), store every upcoming game on the cron as `games`, and post
 * today's slate. Then, at each game's start time, post that game's stream link
 * mentioning `mentions` (KING_USER_ID in the seed).
 *
 * The per-game posts are one-off scheduler jobs built from the stored list
 * (streamGameJobs, reached through the registry's JOB_EXTRAS), not entries of
 * their own under env.crons. Storing the list is a normal — not silent — env
 * write, and that write is what rebuilds the schedule with the new games in
 * it. Games sharing a start time share a scheduler slot and go out one after
 * another on its serial queue, one message each.
 *
 * A slot is weekly (weekday + time), so a game's job would also come round on
 * the same weekday next week; the run checks the game's date against today and
 * the next daily fetch prunes past games, so it never fires twice.
 */

const EMBED_COLOR = 0x1d428a;

/** ET "YYYY-MM-DD" → its day of week, 0 = Sunday. */
const weekdayOf = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

const timeLabel = (game) => (game.time ? `${formatStartTime(game.time)} ET` : "TBD");

/** The day's slate: one line per game, time then linked matchup. */
export function buildSlateEmbed(games, source) {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`Today's games (${games.length})`)
    .setDescription(games.map((game) => `\`${timeLabel(game).padEnd(11)}\` [${game.title}](${game.url})`).join("\n"))
    .setFooter({ text: `${hostOf(source)} · stream links go live about an hour before each start` });
}

export function buildGameEmbed(game) {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(game.title)
    .setURL(game.url)
    .setDescription(`Starts ${timeLabel(game)} — click the title to watch.`)
    .setFooter({ text: hostOf(game.url) });
}

/**
 * Replace cron `id`'s stored games. Skips the write when nothing changed, so a
 * manual re-run doesn't post a fresh env message or rebuild the schedule for
 * nothing.
 */
async function storeGames(client, id, games) {
  const stored = currentEnv().crons?.[id]?.games;
  if (JSON.stringify(stored ?? []) === JSON.stringify(games)) return;
  await writeEnv(
    client,
    (env) => (env.crons?.[id] ? setPath(env, `crons.${id}.games`, games) : env),
    `🗄️ Env updated — cron \`${id}\` stored ${games.length} game(s)`,
  );
}

/**
 * Fetch the schedule for cron `id`, store its upcoming games, and post
 * today's slate.
 *
 * The page is authoritative: the stored list is replaced wholesale, so a
 * postponed game that drops off the page loses its start-time post too. Past
 * days are pruned; today's games stay even once started, since the slate
 * lists them.
 *
 * A failed fetch throws (the scheduler logs it) and leaves the stored list
 * alone, so games stored by yesterday's run for today still go out.
 *
 * `force` (the manual /cron run) bypasses the interval gate and does not stamp
 * lastRun, matching the other jobs.
 * @returns {Promise<import('discord.js').Message|null>} the slate, or null when there are no games today
 */
export async function runStreams({ client }, id, { force = false } = {}) {
  const prepared = prepareRun(id, { force });
  if (!prepared) return null;
  const { env, cron, today, everyDays } = prepared;

  const channel = await resolveChannel(client, env, cron, id);
  if (!channel) return null;

  const source = String(cron.source || DEFAULT_SOURCE).trim();
  const games = (await getSchedule(source)).filter((game) => game.date >= today);
  await storeGames(client, id, games);

  const todays = games.filter((game) => game.date === today);
  console.log(`📺 [chappelly] Streams "${id}": ${games.length} upcoming game(s), ${todays.length} today.`);
  if (!todays.length) return null;

  const header = String(cron.message ?? "").trim();
  const message = await channel.send({
    content: header || undefined,
    embeds: [buildSlateEmbed(todays, source)],
    allowedMentions: { parse: [] },
  });
  if (everyDays && !force) await recordCronRun(client, id, today);
  return message;
}

/**
 * Post one game's stream link as it starts. Reads the live env rather than the
 * game captured when the job was built, so a cron disabled or a game dropped
 * since then stays quiet.
 * @returns {Promise<import('discord.js').Message|null>}
 */
export async function runStreamGame({ client }, id, key) {
  const env = currentEnv();
  const cron = env.crons?.[id];
  if (!cron || cron.enabled === false) return null;

  const game = (Array.isArray(cron.games) ? cron.games : []).find((g) => g?.key === key);
  if (!game) {
    console.log(`⏭️ [chappelly] Streams "${id}": game ${key} is no longer on the schedule, skipping.`);
    return null;
  }
  // The weekly slot coming round again on a later week.
  if (game.date !== toEstDateString(new Date())) return null;

  const channel = await resolveChannel(client, env, cron, id);
  if (!channel) return null;

  const mentions = resolveMentions(env, cron);
  const content = [mentionLine(mentions), `📺 **${game.title}** is starting!`].filter(Boolean).join(" ");
  const message = await channel.send({ content, embeds: [buildGameEmbed(game)] });
  console.log(`📺 [chappelly] Posted "${game.title}" for "${id}" to #${channel.name ?? channel.id}`);
  return message;
}

/**
 * One one-off scheduler job per stored game that is still ahead of us and has
 * a start time. index.js adds these next to the cron's own daily job.
 */
export function streamGameJobs(id, cron) {
  const today = toEstDateString(new Date());
  return (Array.isArray(cron?.games) ? cron.games : [])
    .filter((game) => game?.key && typeof game.date === "string" && game.date >= today && parseHHmm(game.time ?? ""))
    .map((game) => {
      const [hour, minute] = parseHHmm(game.time).split(":").map(Number);
      return {
        name: `${id}: ${game.title} (${game.date})`,
        slots: () => atTime(hour, minute, [weekdayOf(game.date)]),
        run: (ctx) => runStreamGame(ctx, id, game.key),
      };
    });
}

/** "5 upcoming — next: Knicks vs 76ers, 2026-10-05 7:00 PM ET" — used by /cron list. */
export function describeGames(cron) {
  const today = toEstDateString(new Date());
  const upcoming = (Array.isArray(cron?.games) ? cron.games : []).filter((game) => game?.date >= today);
  if (!upcoming.length) return "none stored";
  const next = upcoming[0];
  return `${upcoming.length} upcoming — next: ${next.title}, ${next.date} ${timeLabel(next)}`;
}

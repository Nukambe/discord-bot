import { EmbedBuilder } from "discord.js";
import { recordCronRun } from "../env.js";
import { prepareRun, resolveChannel } from "./common.js";
import { getNews, resolveFeed, urlKey } from "../news.js";

/**
 * The "news" cron (`job: "news"` on an env.crons entry): post whatever is new
 * in the feeds it names, one embed per article. Times, days, channel and
 * `everyDays` work exactly as they do for any other cron, so "every hour" is
 * just 24 entries in `times`.
 *
 * Which feeds it reads is data, like everything else: `feeds` lists preset keys
 * (see FEED_PRESETS in ../news.js) or raw URLs, so adding a paper is an /env
 * edit, not a deploy.
 *
 * Unlike a reminder this carries no button and no mentions — there is nothing
 * to confirm and nobody to nag. `message` is an optional line above the batch.
 *
 * **Dedupe is answered by Discord, not by stored state.** Every post puts the
 * article's URL on its embed, so a run reads the channel's recent messages back
 * and skips any URL already there — familygo's alreadyPosted.js principle. That
 * is what makes this job safe to run hourly, safe to re-run by hand, and safe
 * to fire again at boot: a redundant run finds everything already posted and
 * does nothing. The alternative — remembering posted links in the env — would
 * write a fresh env message to the env channel every hour.
 */

// Discord returns at most 100 messages per fetch. At the dozen-or-so articles a
// day these feeds carry that is several days of scrollback, and MAX_AGE_HOURS
// stops anything older than the window from being a candidate at all, so the
// two together leave no gap for a repeat to slip through.
const SCAN_LIMIT = 100;

/** Defaults for the knobs a cron may override. */
const MAX_AGE_HOURS = 48;
const MAX_PER_FEED = 10;

// Discord's own caps: 10 embeds per message, 6000 characters across them. The
// character budget is the one that actually binds, so batches are split on
// both and the budget is kept a little under the real limit.
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_CHARS_PER_MESSAGE = 5500;

const TITLE_LIMIT = 240;
const SUMMARY_LIMIT = 260;

const truncate = (value, limit) => {
  const s = String(value ?? "").trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1).trimEnd()}…`;
};

/**
 * The article URLs already sitting in the channel, as comparison keys.
 *
 * A failed fetch returns null rather than an empty set — treating "couldn't
 * read the channel" as "nothing posted yet" would repost the whole window.
 * That needs Read Message History in the channel; the client's intents don't
 * come into it, since this is a REST fetch of the bot's own messages rather
 * than a gateway event.
 * @returns {Promise<Set<string>|null>}
 */
async function postedUrls(channel) {
  const messages = await channel.messages.fetch({ limit: SCAN_LIMIT }).catch(() => null);
  if (!messages) return null;
  const urls = new Set();
  for (const message of messages.values()) {
    for (const embed of message.embeds) {
      if (embed.url) urls.add(urlKey(embed.url));
    }
  }
  return urls;
}

/**
 * One article's embed. Split out from the posting so the shape of a post is a
 * pure function of the parsed item — `/cron run` shows it without waiting for
 * the hour.
 */
export function buildArticleEmbed(item) {
  const embed = new EmbedBuilder()
    .setColor(item.feed.color)
    .setAuthor({ name: truncate(item.feed.label, 256) })
    .setTitle(truncate(item.title, TITLE_LIMIT))
    .setURL(item.url);

  if (item.summary) embed.setDescription(truncate(item.summary, SUMMARY_LIMIT));
  // A thumbnail rather than a full image: several of these stack in one
  // message, and full-width art would turn a quiet news hour into a wall.
  if (item.image) embed.setThumbnail(item.image);

  // Patch files stories under a section; NPR only has a byline. Either, both,
  // or neither — whatever the feed actually gave us.
  const footer = [item.section, item.author].filter(Boolean).join(" · ");
  if (footer) embed.setFooter({ text: truncate(footer, 2048) });
  if (item.published) embed.setTimestamp(item.published);

  return embed;
}

/** Roughly how much of a message's 6000-character embed budget one embed uses. */
const embedSize = (embed) => {
  const { title = "", description = "", author, footer } = embed.data;
  return title.length + description.length + (author?.name?.length ?? 0) + (footer?.text?.length ?? 0);
};

/** Split embeds into messages that fit both of Discord's caps. */
export function batchEmbeds(embeds) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const embed of embeds) {
    const size = embedSize(embed);
    if (current.length >= MAX_EMBEDS_PER_MESSAGE || (current.length && chars + size > MAX_EMBED_CHARS_PER_MESSAGE)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(embed);
    chars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Post everything new for cron `id`.
 *
 * Finding nothing new is the normal outcome most hours and returns null without
 * posting. A feed that fails is logged and skipped; only every feed failing
 * throws, so the scheduler logs it and the next slot retries — matching
 * runWeather.
 *
 * `force` (the manual /cron run) bypasses the interval gate and does not stamp
 * lastRun, but deliberately does *not* bypass the channel scan: unlike
 * familygo's /post-daily there is no debug mode here, because a test post of an
 * article already in the channel is exactly the duplicate this job exists to
 * avoid.
 * @returns {Promise<import('discord.js').Message|null>} the last message posted, or null
 */
export async function runNews({ client }, id, { force = false } = {}) {
  const prepared = prepareRun(id, { force });
  if (!prepared) return null;
  const { env, cron, today, everyDays } = prepared;

  const feeds = Array.isArray(cron.feeds) ? cron.feeds.filter(Boolean) : [];
  if (!feeds.length) {
    console.warn(`⚠️ [chappelly] News cron "${id}" has no feeds — set crons.${id}.feeds with /env.`);
    return null;
  }

  const channel = await resolveChannel(client, env, cron, id);
  if (!channel) return null;

  const already = await postedUrls(channel);
  if (!already) {
    throw new Error(`Couldn't read #${channel.name ?? channel.id} to check what's already posted.`);
  }

  const { items, failures } = await getNews(feeds, {
    maxAgeHours: Number(cron.maxAgeHours) || MAX_AGE_HOURS,
    maxPerFeed: Number(cron.maxPerFeed) || MAX_PER_FEED,
  });
  for (const { feed, error } of failures) {
    console.warn(`⚠️ [chappelly] News cron "${id}": feed ${feed.url} failed — ${error}`);
  }
  if (failures.length && failures.length === feeds.length) {
    throw new Error(`every feed failed (${failures.map((f) => f.error).join("; ")})`);
  }

  const fresh = items.filter((item) => !already.has(item.id));
  if (!fresh.length) {
    console.log(`📰 [chappelly] News "${id}": nothing new across ${feeds.length} feed(s).`);
    return null;
  }

  const header = String(cron.message ?? "").trim();
  const batches = batchEmbeds(fresh.map(buildArticleEmbed));

  let last = null;
  for (const [index, embeds] of batches.entries()) {
    last = await channel.send({
      // The header rides on the first message only, so a busy hour doesn't
      // repeat it down the channel.
      content: index === 0 && header ? header : undefined,
      embeds,
      allowedMentions: { parse: [] },
    });
  }

  console.log(
    `📰 [chappelly] Posted ${fresh.length} article(s) for "${id}" to #${channel.name ?? channel.id}` +
      ` (${batches.length} message(s), ${items.length - fresh.length} already there)`,
  );
  if (everyDays && !force) await recordCronRun(client, id, today);
  return last;
}

/** Feed keys a news cron names, resolved — used by /cron list to describe one. */
export const describeFeeds = (cron) =>
  (Array.isArray(cron?.feeds) ? cron.feeds : [])
    .map((entry) => {
      try {
        const feed = resolveFeed(entry);
        return feed.label || feed.url;
      } catch {
        return `⚠️ ${typeof entry === "string" ? entry : JSON.stringify(entry)}`;
      }
    })
    .join(", ");

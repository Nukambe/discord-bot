import { ChannelType } from "discord.js";
import "dotenv/config";

const DB_CHANNEL_ID = "1526768575816270035";
const DB_MARKER = "DB:";
// Written in place of the inline JSON when the db has outgrown a Discord message; the
// payload then rides along as a db.json attachment (see buildDbMessage/readDbFromMessage).
const DB_ATTACHMENT_SENTINEL = "@db.json";
const DB_ATTACHMENT_NAME = "db.json";
// Discord's message cap is 2000 characters; the slack absorbs the title and marker line.
const MAX_INLINE_MESSAGE_LENGTH = 1900;
const changeListeners = new Set();

/**
 * Current config, seeded as the starting point the first time the db is created.
 * Mirrors the values that were previously hardcoded in index.js / giftRotation.js.
 */
export const defaultDb = () => ({
  giftRotation: {
    days: [0, 3],   // cron day-of-week values: 0=Sun, 3=Wed
    time: "19:30",  // ET, 24h HH:mm
    gifs: [
      "https://giphy.com/gifs/the-simpsons-money-6WmyDIKwGvKFO",
    ],
    pause: null,    // { start: "YYYY-MM-DD", end: "YYYY-MM-DD" } (ET, inclusive) or null when not paused

    // Who's in the rotation. Each entry is { id, channel, name }: `id` is a Discord user
    // snowflake for a real user, or a slug for a member who only exists as a channel
    // (formatUserRef in giftRotation.js mentions the former and prints the latter);
    // `channel` is where that member's rotation announcement goes.
    //
    // giftees are the selectable cycle — one is chosen per rotation, and the rest gift.
    // gifters always gift and are never selected.
    //
    // Seeded from the env-var pools that used to be hardcoded in giftRotation.js. Entries
    // with a missing id or channel (an unset env var) are dropped when the rotation runs.
    giftees: [
      { id: process.env.ROLLER_USER_ID, channel: process.env.ROLLER_CHANNEL_ID, name: "DaRoller" },
      { id: process.env.WRECKER_USER_ID, channel: process.env.WRECKER_CHANNEL_ID, name: "DaWrecker" },
      { id: process.env.BUILDER_USER_ID, channel: process.env.BUILDER_CHANNEL_ID, name: "DaBuilder" },
      { id: process.env.COLLECTOR_USER_ID, channel: process.env.COLLECTOR_CHANNEL_ID, name: "DaCollector" },
    ],
    gifters: [
      { id: "oly-lifts", channel: process.env.OLY_CHANNEL_ID, name: "OlyLifts" },
      { id: "mech-e", channel: process.env.MECH_CHANNEL_ID, name: "MechE" },
      { id: "majestic-ruby-71", channel: process.env.MAJESTIC_CHANNEL_ID, name: "MajesticRuby71" },
      { id: process.env.GAMER_USER_ID, channel: process.env.GAMER_CHANNEL_ID, name: "DaGamer" },
      { id: "april-love", channel: "1444766178487832627", name: "AprilLove" },
      { id: "prof-cousin", channel: "1447724785164484720", name: "ProfCousin" },
      { id: process.env.ANCHOR_USER_ID, channel: process.env.ANCHOR_CHANNEL_ID, name: "DaAnchor" },
    ],
  },
  dailyPost: {
    windowStartTime: "19:30",  // ET, 24h HH:mm — first attempt
    windowEndTime: "15:30",    // ET, 24h HH:mm — next day, retries stop here
    retryIntervalMinutes: 30,  // how often it retries until it succeeds
  },
  // State of the most recent post per job, so a scheduled run and its manual
  // slash-command twin can't double-post (see getLastPosts/updateLastPosts).
  lastPosts: {
    daily: null,      // dateSlug of the most recent daily events post
    freeDice: [],     // one key per recently posted free-dice link: its campaign id, or
                      // urlKey() of the resolved claim link (see resolveRewardLink.js)
    futureEvents: {}, // { [category tag or "general"]: urlKey() of its most recent post }
    weekly: null,     // ET date ("YYYY-MM-DD") of the Monday whose week was last posted
                      // by the weekly predictions job (postWeeklyPredictions.js)
    spoilers: {},     // { [wiki collectible category key]: itemIds that were on page 1 of that
                      // category at the end of the last check (postCollectibleSpoilers.js).
                      // A missing key means that category has never been checked, which is
                      // what triggers its one-time silent seed; the ids are how "new" is
                      // decided at all, since the wiki dates none of its collectibles.
  },
  ts: Date.now(),
});

function isTextish(chan) {
  return !!chan && (
    chan.type === ChannelType.GuildText ||
    chan.type === ChannelType.PublicThread ||
    chan.type === ChannelType.PrivateThread
  );
}

async function fetchDbChannel(client) {
  if (!DB_CHANNEL_ID) throw new Error("DB_CHANNEL_ID is not set.");
  const channel = await client.channels.fetch(DB_CHANNEL_ID).catch(() => null);
  if (!isTextish(channel)) throw new Error(`DB channel ${DB_CHANNEL_ID} not found or not a text/thread channel.`);
  return channel;
}

async function fetchLastMessage(channel) {
  const msgs = await channel.messages.fetch({ limit: 1 }).catch(() => null);
  if (!msgs || msgs.size === 0) return null;
  return [...msgs.values()][0];
}

function parseDbFromMessage(content) {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  const dbLine = lines.find(l => l.trim().startsWith(DB_MARKER));
  if (!dbLine) return null;
  const json = dbLine.slice(dbLine.indexOf(DB_MARKER) + DB_MARKER.length).trim();
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Build the message that stores `db`. Normally the JSON sits inline on the `DB:` line, which
 * keeps the channel's scrollback human-readable; once the db outgrows a Discord message the
 * line becomes a sentinel and the JSON goes out as a db.json attachment instead. Both shapes
 * are understood by readDbFromMessage, so old messages keep parsing.
 * @returns {import('discord.js').MessageCreateOptions}
 */
function buildDbMessage(title, db) {
  const json = JSON.stringify(db);
  const inline = [title, "", DB_MARKER + " " + json].join("\n");
  if (inline.length <= MAX_INLINE_MESSAGE_LENGTH) return { content: inline };

  return {
    content: [title, "", DB_MARKER + " " + DB_ATTACHMENT_SENTINEL].join("\n"),
    files: [{ attachment: Buffer.from(json, "utf8"), name: DB_ATTACHMENT_NAME }],
  };
}

/**
 * Read the db out of a message, whether it's stored inline or as a db.json attachment.
 *
 * Returns null only when the message genuinely holds no db. A message that says it carries
 * an attachment whose payload can't be fetched **throws** instead: callers treat null as
 * "nothing here yet" and fall back to defaultDb(), which on a transient CDN blip would
 * silently overwrite the live db with seed values.
 * @param {import('discord.js').Message|null} msg
 * @returns {Promise<object|null>}
 */
async function readDbFromMessage(msg) {
  if (!msg) return null;

  const inline = parseDbFromMessage(msg.content);
  if (inline) return inline;
  if (!msg.content?.includes(DB_ATTACHMENT_SENTINEL)) return null;

  const attachment = [...msg.attachments.values()].find(a => a.name === DB_ATTACHMENT_NAME);
  if (!attachment) throw new Error(`DB message ${msg.id} has no ${DB_ATTACHMENT_NAME} attachment.`);

  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Couldn't download ${DB_ATTACHMENT_NAME} (HTTP ${res.status}).`);
  return JSON.parse(await res.text());
}

/**
 * Ensure the config database exists in the DB channel.
 * Looks at the channel's last message: if it already holds a valid db, leaves
 * it untouched; otherwise posts a fresh message seeded with current defaults.
 * @param {import('discord.js').Client} client
 * @returns {Promise<object>} the active db
 */
export async function initDb(client) {
  const channel = await fetchDbChannel(client);
  const lastMsg = await fetchLastMessage(channel);
  const existing = await readDbFromMessage(lastMsg);
  if (existing) return existing;

  const db = defaultDb();
  await channel.send(buildDbMessage("🗄️ Database initialized", db));
  return db;
}

/**
 * Read the current db without creating one.
 * @param {import('discord.js').Client} client
 * @returns {Promise<object|null>}
 */
export async function getDb(client) {
  const channel = await fetchDbChannel(client);
  const lastMsg = await fetchLastMessage(channel);
  return readDbFromMessage(lastMsg);
}

/**
 * Merge `patch` into the current db and post the result as a new message
 * (the db's history lives in the channel, so every write is a new message).
 * @param {import('discord.js').Client} client
 * @param {object} patch shallow-merged onto the current top-level db keys
 * @returns {Promise<object>} the new db
 */
export async function updateDb(client, patch) {
  const channel = await fetchDbChannel(client);
  const lastMsg = await fetchLastMessage(channel);
  const current = (await readDbFromMessage(lastMsg)) ?? defaultDb();

  const next = { ...current, ...patch, ts: Date.now() };
  await channel.send(buildDbMessage("🗄️ Database updated", next));

  for (const listener of changeListeners) {
    try {
      listener(next);
    } catch (err) {
      console.error("💥 db change listener failed:", err);
    }
  }

  return next;
}

/**
 * Read the last-post state (see defaultDb().lastPosts). Never throws — a db
 * that can't be read returns {} so the caller falls back to its channel-scan
 * dedupe rather than blocking a post.
 * @param {import('discord.js').Client} client
 * @returns {Promise<object>}
 */
export async function getLastPosts(client) {
  try {
    const db = await getDb(client);
    return db?.lastPosts ?? {};
  } catch (err) {
    console.warn("⚠️ Couldn't read last-post state, continuing without it:", err.message);
    return {};
  }
}

/**
 * Merge `patch` into db.lastPosts and post the result as a new db message.
 * Values in `patch` replace their key wholesale — callers maintaining a nested
 * object (futureEvents) pass the already-merged object.
 *
 * Deliberately does NOT fire onDbChange listeners: those restart the schedule
 * crons, and post-state writes happen after every post — nothing about the
 * schedule changed. Never throws — failing to record state must not fail the
 * post that just went out (the channel-scan dedupe still covers the gap).
 * @param {import('discord.js').Client} client
 * @param {object} patch shallow-merged onto db.lastPosts
 * @returns {Promise<object|null>} the new db, or null if the write failed
 */
export async function updateLastPosts(client, patch) {
  try {
    const channel = await fetchDbChannel(client);
    const lastMsg = await fetchLastMessage(channel);
    const current = (await readDbFromMessage(lastMsg)) ?? defaultDb();
    const lastPosts = { ...defaultDb().lastPosts, ...current.lastPosts, ...patch };
    const next = { ...current, lastPosts, ts: Date.now() };
    await channel.send(buildDbMessage("🗄️ Database updated (last posts)", next));
    return next;
  } catch (err) {
    console.warn("⚠️ Couldn't record last-post state:", err.message);
    return null;
  }
}

/**
 * Register a callback fired with the new db whenever a command updates it
 * via updateDb(). Returns an unsubscribe function.
 * @param {(db: object) => void} listener
 * @returns {() => void}
 */
export function onDbChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

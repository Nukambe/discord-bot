import { ChannelType } from "discord.js";
import "dotenv/config";

const DB_CHANNEL_ID = "1526768575816270035";
const DB_MARKER = "DB:";
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
  },
  dailyPost: {
    windowStartTime: "19:30",  // ET, 24h HH:mm — first attempt
    windowEndTime: "15:30",    // ET, 24h HH:mm — next day, retries stop here
    retryIntervalMinutes: 30,  // how often it retries until it succeeds
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

function formatDbMessage(title, db) {
  return [title, "", DB_MARKER + " " + JSON.stringify(db)].join("\n");
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
  const existing = parseDbFromMessage(lastMsg?.content);
  if (existing) return existing;

  const db = defaultDb();
  await channel.send(formatDbMessage("🗄️ Database initialized", db));
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
  return parseDbFromMessage(lastMsg?.content);
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
  const current = parseDbFromMessage(lastMsg?.content) ?? defaultDb();

  const next = { ...current, ...patch, ts: Date.now() };
  await channel.send(formatDbMessage("🗄️ Database updated", next));

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
 * Register a callback fired with the new db whenever a command updates it
 * via updateDb(). Returns an unsubscribe function.
 * @param {(db: object) => void} listener
 * @returns {() => void}
 */
export function onDbChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

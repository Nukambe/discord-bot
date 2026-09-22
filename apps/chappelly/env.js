import { ChannelType } from "discord.js";
import { ALL_DAYS } from "./cronScheduler.js";
import { toEstDateString } from "../../util/dateUtils.js";

/**
 * chappelly's "env": every runtime setting the bot has, kept as one JSON
 * document in a dedicated Discord channel rather than in the process
 * environment, so it can be edited from inside Discord (/env, /cron) without a
 * redeploy. Only the bot token comes from the real .env.
 *
 * Storage follows familygo's db.js: every write posts a new message carrying
 * the JSON on an `ENV:` line (history is the channel's scrollback), and the
 * newest such message is the live env. Two differences worth knowing:
 *   - the reader scans back through recent messages for the marker instead of
 *     trusting only the very last message, so a stray chat message in the
 *     channel can't make the bot think there is no env and re-seed defaults;
 *   - the live env is cached in memory after every read/write, because
 *     autocomplete (3s deadline) and button clicks look it up constantly.
 * Once the JSON outgrows a Discord message the line becomes the sentinel
 * `@env.json` and the payload rides along as an attachment.
 */

export const ENV_CHANNEL_ID = "1552074366307536989";
const MARKER = "ENV:";
const ATTACHMENT_SENTINEL = "@env.json";
const ATTACHMENT_NAME = "env.json";
// Discord's message cap is 2000 characters; the slack absorbs the title and marker line.
const MAX_INLINE_MESSAGE_LENGTH = 1900;
// How far back to look for the newest ENV: message before deciding there is none.
const SCAN_LIMIT = 50;

/** Keys a direct edit may not touch. */
export const RESERVED_KEYS = new Set(["ts"]);
export const PATH_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/**
 * Seed env, posted the first time the channel is empty. Cron entries are keyed
 * by id under `crons`; each is
 *   { enabled, times: ["HH:mm" ET], days: [0-6, 0 = Sun], channel, message, gif, mentions, button,
 *     everyDays?, lastRun? }
 * where `mentions` lists env key names (KING_USER_ID) or raw user ids, an
 * empty `channel` falls back to REMINDER_CHANNEL_ID, and `gif` (a URL) goes on
 * its own line under the message so Discord embeds it.
 *
 * `everyDays` turns the cron into an interval: its times/days still decide
 * when it *may* fire, but it only posts once `everyDays` days have passed
 * since `lastRun` (an ET "YYYY-MM-DD", stamped on every post). /cron reset
 * stamps lastRun with today, which is what pushes the next post out again.
 */
export const defaultEnv = () => ({
  KING_USER_ID: "",
  QUEEN_USER_ID: "",
  REMINDER_CHANNEL_ID: "",
  crons: {
    "neema-pill": {
      enabled: true,
      times: ["06:00", "18:00"],
      days: [...ALL_DAYS],
      channel: "",
      message: "💊 Time for Neema's pill! Did you give it to her?",
      mentions: ["KING_USER_ID", "QUEEN_USER_ID"],
      button: "YES",
    },
    "neema-food": {
      enabled: true,
      times: ["07:00", "19:00"],
      days: [...ALL_DAYS],
      channel: "",
      message: "🍽️ Time to feed Neema! Did you feed her?",
      mentions: ["KING_USER_ID", "QUEEN_USER_ID"],
      button: "YES",
    },
    "king-queen-gif": {
      enabled: true,
      times: ["08:00"],
      days: [...ALL_DAYS],
      everyDays: 3,
      // Seeded as "already posted today", so the first post lands 3 days after seeding.
      lastRun: toEstDateString(new Date()),
      channel: "",
      message: "",
      gif: "https://klipy.com/gifs/dudu-massage-bubu-ass-oh-yeah-baby",
      mentions: ["KING_USER_ID", "QUEEN_USER_ID"],
      button: "",
    },
  },
  ts: Date.now(),
});

// ---------------------------------------------------------------------------
// Dotted-path helpers (pure)
// ---------------------------------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `getPath(env, "crons.neema-pill.times")` → the value, or undefined. */
export function getPath(obj, path) {
  return path.split(".").reduce((acc, key) => (isPlainObject(acc) ? acc[key] : undefined), obj);
}

/** Returns a copy of `obj` with `value` written at `path`, creating objects along the way. */
export function setPath(obj, path, value) {
  const next = structuredClone(obj);
  const keys = path.split(".");
  let node = next;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
  return next;
}

/** Returns `{ next, existed }` — a copy of `obj` without `path`. */
export function deletePath(obj, path) {
  const next = structuredClone(obj);
  const keys = path.split(".");
  let node = next;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) return { next, existed: false };
    node = node[key];
  }
  const last = keys.at(-1);
  const existed = Object.prototype.hasOwnProperty.call(node, last);
  delete node[last];
  return { next, existed };
}

/**
 * Every editable path in the env, objects included (so a whole cron can be
 * replaced in one edit). Arrays are leaves — edit them as JSON.
 */
export function listPaths(obj, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(obj ?? {})) {
    if (!prefix && RESERVED_KEYS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    if (isPlainObject(value)) out.push(...listPaths(value, path));
  }
  return out;
}

/**
 * How `/env set` interprets typed input: objects, arrays, booleans and null are
 * parsed as JSON; everything else — including bare digits — stays a string.
 * Snowflakes are the reason: JSON.parse("1552074366307536989") silently loses
 * precision, and every id in this env is a snowflake.
 */
export function parseEnvValue(raw) {
  const s = String(raw).trim();
  if (/^[\[{"]/.test(s) || /^(true|false|null)$/.test(s)) {
    try {
      return JSON.parse(s);
    } catch (err) {
      throw new Error(`That looks like JSON but doesn't parse: ${err.message}`);
    }
  }
  return s;
}

export const formatEnvValue = (value) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

// ---------------------------------------------------------------------------
// Channel storage
// ---------------------------------------------------------------------------

let cache = null;
const changeListeners = new Set();
let writeQueue = Promise.resolve();

/** The last env read or written this process — never null, defaults before first read. */
export const currentEnv = () => cache ?? defaultEnv();

function isTextish(chan) {
  return !!chan && (
    chan.type === ChannelType.GuildText ||
    chan.type === ChannelType.PublicThread ||
    chan.type === ChannelType.PrivateThread
  );
}

export async function fetchEnvChannel(client) {
  const channel = await client.channels.fetch(ENV_CHANNEL_ID).catch(() => null);
  if (!isTextish(channel)) throw new Error(`Env channel ${ENV_CHANNEL_ID} not found or not a text/thread channel.`);
  return channel;
}

/** Newest message in the channel that carries an ENV: line, or null. */
async function findEnvMessage(channel) {
  const msgs = await channel.messages.fetch({ limit: SCAN_LIMIT }).catch(() => null);
  if (!msgs) return null;
  // fetch() returns newest-first, and every write re-posts the env, so the
  // first marker message is the current one.
  return [...msgs.values()].find((m) => envLineOf(m.content) !== null) ?? null;
}

function envLineOf(content) {
  if (!content) return null;
  const line = content.split(/\r?\n/).find((l) => l.trim().startsWith(MARKER));
  return line ? line.slice(line.indexOf(MARKER) + MARKER.length).trim() : null;
}

/**
 * Read the env out of a message, inline or attached. Throws — rather than
 * returning null — when a sentinel message's attachment can't be fetched, so a
 * CDN blip can't be mistaken for "no env yet" and overwrite the live env.
 */
async function readEnvFromMessage(msg) {
  const line = envLineOf(msg?.content);
  if (line === null) return null;

  if (line !== ATTACHMENT_SENTINEL) {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Env message ${msg.id} holds unparseable JSON.`);
    }
  }

  const attachment = [...msg.attachments.values()].find((a) => a.name === ATTACHMENT_NAME);
  if (!attachment) throw new Error(`Env message ${msg.id} has no ${ATTACHMENT_NAME} attachment.`);
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Couldn't download ${ATTACHMENT_NAME} (HTTP ${res.status}).`);
  return JSON.parse(await res.text());
}

/** @returns {import('discord.js').MessageCreateOptions} */
function buildEnvMessage(title, env) {
  const json = JSON.stringify(env);
  const inline = [title, "", `${MARKER} ${json}`].join("\n");
  if (inline.length <= MAX_INLINE_MESSAGE_LENGTH) return { content: inline };
  return {
    content: [title, "", `${MARKER} ${ATTACHMENT_SENTINEL}`].join("\n"),
    files: [{ attachment: Buffer.from(json, "utf8"), name: ATTACHMENT_NAME }],
  };
}

async function readLatest(channel) {
  const env = await readEnvFromMessage(await findEnvMessage(channel));
  if (env) cache = env;
  return env;
}

/**
 * Load the env, seeding the channel with defaults if it holds none yet.
 * @param {import('discord.js').Client} client
 * @returns {Promise<object>}
 */
export async function initEnv(client) {
  const channel = await fetchEnvChannel(client);
  const existing = await readLatest(channel);
  if (existing) return existing;

  const env = defaultEnv();
  await channel.send(buildEnvMessage("🗄️ Env initialized", env));
  cache = env;
  return env;
}

/**
 * Re-read the env from the channel (updates the cache). Returns null when the
 * channel holds no env.
 */
export async function refreshEnv(client) {
  return readLatest(await fetchEnvChannel(client));
}

/**
 * Apply `mutate(currentEnv) -> nextEnv` against the freshest env and post the
 * result. Writes are serialized so two commands can't interleave their
 * read-modify-write, and every listener registered with onEnvChange is told
 * about the new env (index.js rebuilds the cron schedule from it) — unless
 * `silent` is set, for state writes that change nothing about the schedule.
 * @returns {Promise<object>} the new env
 */
export function writeEnv(client, mutate, title = "🗄️ Env updated", { silent = false } = {}) {
  const run = writeQueue.then(async () => {
    const channel = await fetchEnvChannel(client);
    const current = (await readLatest(channel)) ?? defaultEnv();
    const next = { ...mutate(structuredClone(current)), ts: Date.now() };
    await channel.send(buildEnvMessage(title, next));
    cache = next;

    if (silent) return next;
    for (const listener of changeListeners) {
      try {
        listener(next);
      } catch (err) {
        console.error("💥 [chappelly] env change listener failed:", err);
      }
    }
    return next;
  });
  writeQueue = run.then(() => {}, () => {});
  return run;
}

export const setEnvValue = (client, path, value) =>
  writeEnv(client, (env) => setPath(env, path, value), `🗄️ Env updated — \`${path}\``);

export const deleteEnvValue = (client, path) =>
  writeEnv(client, (env) => deletePath(env, path).next, `🗄️ Env updated — removed \`${path}\``);

/**
 * Stamp `crons.<id>.lastRun` (ET "YYYY-MM-DD") without rebuilding the
 * schedule: an interval cron records this after every post, and /cron reset
 * uses it to restart the countdown. Never throws — failing to record must not
 * fail the post that just went out.
 * @returns {Promise<object|null>} the new env, or null if the write failed
 */
export async function recordCronRun(client, id, date, title = `🗄️ Env updated — cron \`${id}\` ran ${date}`) {
  try {
    return await writeEnv(
      client,
      (env) => (env.crons?.[id] ? setPath(env, `crons.${id}.lastRun`, date) : env),
      title,
      { silent: true },
    );
  } catch (err) {
    console.warn(`⚠️ [chappelly] Couldn't record lastRun for cron "${id}":`, err.message);
    return null;
  }
}

/**
 * Register a callback fired with the new env after every write. Returns an
 * unsubscribe function.
 */
export function onEnvChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

import { AttachmentBuilder, ChannelType } from "discord.js";

/**
 * Ball-image storage for /balls, backed by the same Discord channel as
 * buildsDb.js and following its scheme exactly (the index is a JSON attachment
 * on the channel's newest marker message, each image is its own message whose
 * id the record stores, writes are serialized read-modify-writes). The only
 * structural difference: records are keyed by the *user* who added them, not
 * by a roster character, and each user entry remembers the username it was
 * saved under so `/balls show` can look people up by name without a mention.
 *
 * The two indexes coexist in one channel under different content markers.
 * Because each db's writes push the other's index message further down the
 * channel, findDbMessage pages beyond a single fetch — losing sight of an
 * index would silently orphan every image it tracks.
 */

const BALLS_CHANNEL_ID = "1539816317001933061";
const DB_MARKER = "BALLS_DB:";
const DB_FILENAME = "balls-db.json";
/** Page size / total depth of the index scan. */
const DB_SCAN_PAGE = 100;
const DB_SCAN_MAX = 500;

export const MAX_BALLS_PER_USER = 10;
/** Re-uploading is capped well under Discord's own limit for a clear error. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** An error whose message is safe to show the user verbatim. */
export class BallsError extends Error {}

let writeQueue = Promise.resolve();
function serialize(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(() => {}, () => {});
  return run;
}

function isTextish(chan) {
  return !!chan && (
    chan.type === ChannelType.GuildText ||
    chan.type === ChannelType.PublicThread ||
    chan.type === ChannelType.PrivateThread
  );
}

async function fetchBallsChannel(client) {
  const channel = await client.channels.fetch(BALLS_CHANNEL_ID).catch(() => null);
  if (!isTextish(channel)) {
    throw new BallsError(`Balls channel ${BALLS_CHANNEL_ID} not found or not a text channel.`);
  }
  return channel;
}

// balls: { [userId]: { name: string, list: [{ id, ts }] } }
const emptyDb = () => ({ balls: {}, ts: Date.now() });

async function findDbMessage(channel) {
  let before;
  for (let scanned = 0; scanned < DB_SCAN_MAX; ) {
    const msgs = await channel.messages
      .fetch({ limit: DB_SCAN_PAGE, ...(before ? { before } : {}) })
      .catch(() => null);
    if (!msgs || msgs.size === 0) return null;

    // fetch() returns newest-first, and every write re-posts the index, so the
    // first marker message is the current one.
    const hit = [...msgs.values()].find((m) => m.content?.startsWith(DB_MARKER));
    if (hit) return hit;

    scanned += msgs.size;
    if (msgs.size < DB_SCAN_PAGE) return null;
    before = msgs.last().id;
  }
  return null;
}

/**
 * Load the index. Returns the channel and index message alongside it so a
 * write can reuse both without re-fetching.
 */
async function readDb(client) {
  const channel = await fetchBallsChannel(client);
  const dbMessage = await findDbMessage(channel);
  if (!dbMessage) return { channel, dbMessage: null, db: emptyDb() };

  const file = dbMessage.attachments.find((a) => a.name === DB_FILENAME);
  if (!file) throw new BallsError("The balls index message is missing its data file.");

  const res = await fetch(file.url).catch(() => null);
  if (!res?.ok) throw new BallsError("Couldn't download the balls index.");

  let db;
  try {
    db = await res.json();
  } catch {
    // Never fall back to an empty db here — that would orphan every ball.
    throw new BallsError("The balls index is corrupted and couldn't be parsed.");
  }
  if (!db || typeof db.balls !== "object") throw new BallsError("The balls index is malformed.");
  return { channel, dbMessage, db };
}

/** Post the index as the channel's newest message, then drop the old one. */
async function writeDb(channel, db, previousDbMessage) {
  db.ts = Date.now();
  const entries = Object.values(db.balls);
  const total = entries.reduce((n, e) => n + e.list.length, 0);
  const file = new AttachmentBuilder(Buffer.from(JSON.stringify(db), "utf8"), { name: DB_FILENAME });

  await channel.send({
    content: `${DB_MARKER} ${total} ball(s) across ${entries.length} user(s) — updated <t:${Math.floor(Date.now() / 1000)}:R>`,
    files: [file],
  });
  await previousDbMessage?.delete().catch(() => {});
}

function fileNameFor(attachment) {
  const ext = /\.(png|jpe?g|gif|webp)$/i.exec(attachment.name ?? "")?.[0]
    ?? (attachment.contentType?.includes("gif") ? ".gif" : ".png");
  return `ball${ext.toLowerCase()}`;
}

/**
 * Find a user's entry by stored username (case-insensitive) or raw user id.
 * Exact name matches win; otherwise a substring match is accepted so a
 * free-typed partial still resolves.
 * @returns {{userId: string, name: string, list: Array}|null}
 */
function resolveEntry(db, query) {
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return null;

  const entries = Object.entries(db.balls).map(([userId, e]) => ({ userId, ...e }));
  return entries.find((e) => e.userId === needle)
    ?? entries.find((e) => e.name?.toLowerCase() === needle)
    ?? entries.find((e) => e.name?.toLowerCase().includes(needle))
    ?? null;
}

/**
 * Re-post a user's image into the balls channel and index it under that user.
 * @param {import('discord.js').Client} client
 * @param {{userId: string, name: string, attachment: import('discord.js').Attachment}} opts
 * @returns {Promise<{record: object, count: number, messageUrl: string}>}
 */
export function addBall(client, { userId, name, attachment }) {
  return serialize(async () => {
    const { channel, dbMessage, db } = await readDb(client);
    const entry = db.balls[userId] ?? { name, list: [] };

    if (entry.list.length >= MAX_BALLS_PER_USER) {
      throw new BallsError(
        `You already have the maximum of ${MAX_BALLS_PER_USER} balls saved. Remove one first with \`/balls remove\`.`
      );
    }

    const posted = await channel.send({
      content: `🎱 **${name}** — added by <@${userId}>`,
      files: [new AttachmentBuilder(attachment.url, { name: fileNameFor(attachment) })],
    });

    const record = { id: posted.id, ts: Date.now() };
    // Keep the stored name current — it's what /balls show looks people up by.
    db.balls[userId] = { name, list: [...entry.list, record] };

    try {
      await writeDb(channel, db, dbMessage);
    } catch (err) {
      // Don't leave an image behind that the index doesn't know about.
      await posted.delete().catch(() => {});
      throw err;
    }

    return { record, count: db.balls[userId].list.length, messageUrl: posted.url };
  });
}

/**
 * Delete a ball, but only if `userId` is the one who added it.
 * @returns {Promise<{name: string}>}
 */
export function removeBall(client, { id, userId }) {
  return serialize(async () => {
    const { channel, dbMessage, db } = await readDb(client);

    const owner = Object.entries(db.balls).find(([, e]) => e.list.some((r) => r.id === id));
    if (!owner) throw new BallsError(`No ball found with ID \`${id}\`.`);

    const [ownerId, entry] = owner;
    if (ownerId !== userId) throw new BallsError("You can only remove balls you added yourself.");

    const list = entry.list.filter((r) => r.id !== id);
    if (list.length === 0) delete db.balls[ownerId];
    else db.balls[ownerId] = { ...entry, list };

    await channel.messages.fetch(id).then((m) => m.delete()).catch(() => {});
    await writeDb(channel, db, dbMessage);
    return { name: entry.name };
  });
}

/**
 * Every ball saved for the user matching `query` (a stored username, no
 * mention needed), each with a freshly signed image url. `url` is null when
 * the underlying message was deleted outside the bot.
 * @returns {Promise<{userId: string, name: string, balls: Array<{id: string, ts: number, url: string|null}>}|null>}
 */
export async function listBalls(client, query) {
  const { channel, db } = await readDb(client);
  const entry = resolveEntry(db, query);
  if (!entry) return null;

  const balls = await Promise.all(entry.list.map(async (record) => {
    // force: true — a cached message carries the signature it was fetched
    // with, which may already have expired.
    const msg = await channel.messages.fetch({ message: record.id, force: true }).catch(() => null);
    return { ...record, url: msg?.attachments?.first()?.url ?? null };
  }));

  return { userId: entry.userId, name: entry.name, balls };
}

/**
 * One user's own balls, newest first — backs `/balls remove` autocomplete so
 * nobody has to type a snowflake by hand.
 * @returns {Promise<Array<{id: string, ts: number}>>}
 */
export async function listUserBalls(client, userId) {
  const { db } = await readDb(client);
  return [...(db.balls[userId]?.list ?? [])].sort((a, b) => b.ts - a.ts);
}

/**
 * Stored usernames matching a partial query, prefix matches first — backs
 * `/balls show` autocomplete (mention-free lookup).
 * @returns {Promise<string[]>}
 */
export async function searchBallUsers(client, query, limit = 25) {
  const { db } = await readDb(client);
  const names = [...new Set(Object.values(db.balls).map((e) => e.name).filter(Boolean))];
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return names.slice(0, limit);

  const starts = [];
  const contains = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith(needle)) starts.push(name);
    else if (lower.includes(needle)) contains.push(name);
  }
  return [...starts, ...contains].slice(0, limit);
}

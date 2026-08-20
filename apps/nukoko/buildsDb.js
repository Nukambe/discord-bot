import { AttachmentBuilder, ChannelType } from "discord.js";

/**
 * Build-image storage, backed by a dedicated Discord channel.
 *
 * Same idea as apps/familygo/db.js (the index lives in the channel's *last*
 * message and every write posts a new one), with two differences forced by
 * storing images:
 *
 *  - The index is a JSON *attachment*, not a marker line. At capacity the
 *    index is tens of KB, well past the 2000-char message content limit.
 *  - Each build image is its own message in the same channel, and the record
 *    stores that message's id. Discord CDN links are signed and expire after
 *    ~24h, so a saved url would rot; re-fetching the message at read time
 *    always yields a freshly signed url.
 *
 * Writes are serialized in-process (see `serialize`) because every one of them
 * is a read-modify-write against the index message.
 */

const BUILDS_CHANNEL_ID = "1539816317001933061";
const DB_MARKER = "BUILDS_DB:";
const DB_FILENAME = "builds-db.json";
/** How far back to look for the index if something else posted after it. */
const DB_SCAN_LIMIT = 25;

export const MAX_BUILDS_PER_CHARACTER = 10;
/** Re-uploading is capped well under Discord's own limit for a clear error. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** An error whose message is safe to show the user verbatim. */
export class BuildsError extends Error {}

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

async function fetchBuildsChannel(client) {
  const channel = await client.channels.fetch(BUILDS_CHANNEL_ID).catch(() => null);
  if (!isTextish(channel)) {
    throw new BuildsError(`Builds channel ${BUILDS_CHANNEL_ID} not found or not a text channel.`);
  }
  return channel;
}

const emptyDb = () => ({ builds: {}, ts: Date.now() });

async function findDbMessage(channel) {
  const msgs = await channel.messages.fetch({ limit: DB_SCAN_LIMIT }).catch(() => null);
  if (!msgs || msgs.size === 0) return null;
  // fetch() returns newest-first, and every write re-posts the index, so the
  // first marker message is the current one.
  return [...msgs.values()].find((m) => m.content?.startsWith(DB_MARKER)) ?? null;
}

/**
 * Load the index. Returns the channel and index message alongside it so a
 * write can reuse both without re-fetching.
 */
async function readDb(client) {
  const channel = await fetchBuildsChannel(client);
  const dbMessage = await findDbMessage(channel);
  if (!dbMessage) return { channel, dbMessage: null, db: emptyDb() };

  const file = dbMessage.attachments.find((a) => a.name === DB_FILENAME);
  if (!file) throw new BuildsError("The builds index message is missing its data file.");

  const res = await fetch(file.url).catch(() => null);
  if (!res?.ok) throw new BuildsError("Couldn't download the builds index.");

  let db;
  try {
    db = await res.json();
  } catch {
    // Never fall back to an empty db here — that would orphan every build.
    throw new BuildsError("The builds index is corrupted and couldn't be parsed.");
  }
  if (!db || typeof db.builds !== "object") throw new BuildsError("The builds index is malformed.");
  return { channel, dbMessage, db };
}

/** Post the index as the channel's newest message, then drop the old one. */
async function writeDb(channel, db, previousDbMessage) {
  db.ts = Date.now();
  const lists = Object.values(db.builds);
  const total = lists.reduce((n, list) => n + list.length, 0);
  const file = new AttachmentBuilder(Buffer.from(JSON.stringify(db), "utf8"), { name: DB_FILENAME });

  await channel.send({
    content: `${DB_MARKER} ${total} build(s) across ${lists.length} character(s) — updated <t:${Math.floor(Date.now() / 1000)}:R>`,
    files: [file],
  });
  await previousDbMessage?.delete().catch(() => {});
}

function fileNameFor(attachment) {
  const ext = /\.(png|jpe?g|gif|webp)$/i.exec(attachment.name ?? "")?.[0]
    ?? (attachment.contentType?.includes("gif") ? ".gif" : ".png");
  return `build${ext.toLowerCase()}`;
}

/**
 * Re-post a user's image into the builds channel and index it.
 * @param {import('discord.js').Client} client
 * @param {{character: string, userId: string, attachment: import('discord.js').Attachment}} opts
 * @returns {Promise<{record: object, count: number, messageUrl: string}>}
 */
export function addBuild(client, { character, userId, attachment }) {
  return serialize(async () => {
    const { channel, dbMessage, db } = await readDb(client);
    const list = db.builds[character] ?? [];

    if (list.length >= MAX_BUILDS_PER_CHARACTER) {
      throw new BuildsError(
        `**${character}** already has the maximum of ${MAX_BUILDS_PER_CHARACTER} builds. Remove one of yours first with \`/builds remove\`.`
      );
    }

    const posted = await channel.send({
      content: `📐 **${character}** — added by <@${userId}>`,
      files: [new AttachmentBuilder(attachment.url, { name: fileNameFor(attachment) })],
    });

    const record = { id: posted.id, by: userId, ts: Date.now() };
    db.builds[character] = [...list, record];

    try {
      await writeDb(channel, db, dbMessage);
    } catch (err) {
      // Don't leave an image behind that the index doesn't know about.
      await posted.delete().catch(() => {});
      throw err;
    }

    return { record, count: db.builds[character].length, messageUrl: posted.url };
  });
}

/**
 * Delete a build, but only if `userId` is the one who added it.
 * @returns {Promise<{character: string}>}
 */
export function removeBuild(client, { id, userId }) {
  return serialize(async () => {
    const { channel, dbMessage, db } = await readDb(client);

    let character = null;
    let record = null;
    for (const [name, list] of Object.entries(db.builds)) {
      const hit = list.find((r) => r.id === id);
      if (hit) {
        character = name;
        record = hit;
        break;
      }
    }

    if (!record) throw new BuildsError(`No build found with ID \`${id}\`.`);
    if (record.by !== userId) throw new BuildsError("You can only remove builds you added yourself.");

    db.builds[character] = db.builds[character].filter((r) => r.id !== id);
    if (db.builds[character].length === 0) delete db.builds[character];

    await channel.messages.fetch(id).then((m) => m.delete()).catch(() => {});
    await writeDb(channel, db, dbMessage);
    return { character };
  });
}

/**
 * Every build saved for a character, each with a freshly signed image url.
 * `url` is null when the underlying message was deleted outside the bot.
 * @returns {Promise<Array<{id: string, by: string, ts: number, url: string|null}>>}
 */
export async function listBuilds(client, character) {
  const { channel, db } = await readDb(client);
  const list = db.builds[character] ?? [];

  return Promise.all(list.map(async (record) => {
    // force: true — a cached message carries the signature it was fetched
    // with, which may already have expired.
    const msg = await channel.messages.fetch({ message: record.id, force: true }).catch(() => null);
    return { ...record, url: msg?.attachments?.first()?.url ?? null };
  }));
}

/**
 * Flat list of one user's builds, newest first — backs `/builds remove`
 * autocomplete so nobody has to type a snowflake by hand.
 * @returns {Promise<Array<{id: string, by: string, ts: number, character: string}>>}
 */
export async function listUserBuilds(client, userId) {
  const { db } = await readDb(client);
  return Object.entries(db.builds)
    .flatMap(([character, list]) => list.filter((r) => r.by === userId).map((r) => ({ ...r, character })))
    .sort((a, b) => b.ts - a.ts);
}

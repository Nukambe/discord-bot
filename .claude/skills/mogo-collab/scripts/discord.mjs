// Discord REST helper for the mogo-collab skill. Talks to Discord as daBot (familygo's
// DISCORD_TOKEN) so the skill can read the collaboration channel and the bot's state
// channels, and post/edit patch notes, without booting the bot.
//
// Run from the repo root so .env resolves:
//   node --env-file=.env .claude/skills/mogo-collab/scripts/discord.mjs <command> [...]
//
// Commands:
//   since-notes [--channel <id>]          Everything after daBot's latest "**Patch notes" message
//                                          (that message included, for context). Default channel:
//                                          the collaboration channel.
//   read <channelId> [--limit N] [--after <msgId>] [--before <msgId>]
//                                          Messages oldest-first (N up to 500, paged).
//   message <channelId> <messageId>       One message as raw JSON (forwards, replies, embeds).
//   db [--history N] [--out <file>]       familygo's db: the latest version as JSON, or the last N
//                                          versions (newest first) with their timestamps.
//   post <channelId> <file>               Post a file's contents as daBot (no pings).
//   edit <channelId> <messageId> <file>   Replace a daBot message's content (no pings).

import fs from "node:fs";

const API = "https://discord.com/api/v10";
const COLLAB_CHANNEL_ID = "1456432233870266504";
const DB_CHANNEL_ID = "1526768575816270035"; // apps/familygo/db.js
const PATCH_NOTES_PREFIX = "**Patch notes";

const token = process.env.DISCORD_TOKEN;
if (!token) fail("DISCORD_TOKEN is not set — run with `node --env-file=.env` from the repo root.");
const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };

const [command, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);

const commands = {
  "since-notes": sinceNotes,
  read,
  message,
  db,
  post,
  edit,
};
if (!commands[command]) fail(`Unknown command "${command ?? ""}". See the header of this file for usage.`);
await commands[command]();

async function sinceNotes() {
  const channelId = flags.channel ?? COLLAB_CHANNEL_ID;
  const messages = await fetchMessages(channelId, { limit: 500 });
  const lastNotes = messages.findLastIndex((m) => m.author.bot && m.content.startsWith(PATCH_NOTES_PREFIX));
  if (lastNotes === -1) {
    console.log(`(no daBot patch notes in the last ${messages.length} messages — showing them all)\n`);
    messages.forEach(printMessage);
    return;
  }
  const after = messages.slice(lastNotes + 1);
  console.log(`Latest patch notes (${messages[lastNotes].id}, ${messages[lastNotes].timestamp}):\n`);
  printMessage(messages[lastNotes]);
  console.log(`\n===== ${after.length} message(s) since =====\n`);
  after.forEach(printMessage);
}

async function read() {
  const [channelId] = positional;
  if (!channelId) fail("read needs a channel id");
  const messages = await fetchMessages(channelId, {
    limit: Number(flags.limit ?? 50),
    after: flags.after,
    before: flags.before,
  });
  messages.forEach(printMessage);
}

async function message() {
  const [channelId, messageId] = positional;
  if (!channelId || !messageId) fail("message needs a channel id and a message id");
  console.log(JSON.stringify(await api(`/channels/${channelId}/messages/${messageId}`), null, 1));
}

async function db() {
  const count = Number(flags.history ?? 1);
  const messages = (await fetchMessages(DB_CHANNEL_ID, { limit: Math.max(count * 2, 20) })).reverse();
  const versions = [];
  for (const m of messages) {
    if (versions.length >= count) break;
    const parsed = await readDb(m);
    if (parsed) versions.push({ at: m.timestamp, messageId: m.id, db: parsed });
  }
  const out = JSON.stringify(count === 1 ? versions[0]?.db ?? null : versions, null, 1);
  if (flags.out) {
    fs.writeFileSync(flags.out, out);
    console.log(`Wrote ${versions.length} db version(s) to ${flags.out}`);
  } else {
    console.log(out);
  }
}

async function post() {
  const [channelId, file] = positional;
  if (!channelId || !file) fail("post needs a channel id and a file");
  const sent = await api(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: readContent(file), allowed_mentions: { parse: [] } }),
  });
  console.log(`Posted ${sent.id} as ${sent.author?.username}`);
}

async function edit() {
  const [channelId, messageId, file] = positional;
  if (!channelId || !messageId || !file) fail("edit needs a channel id, a message id and a file");
  const sent = await api(`/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ content: readContent(file), allowed_mentions: { parse: [] } }),
  });
  console.log(`Edited ${sent.id} (${sent.edited_timestamp})`);
}

/* ------------------------------ helpers ------------------------------ */

/** Up to `limit` messages, oldest first, paging past Discord's 100-per-request cap. */
async function fetchMessages(channelId, { limit = 50, after, before } = {}) {
  const all = [];
  let cursor = after ? { after } : before ? { before } : {};
  while (all.length < limit) {
    const page = Math.min(100, limit - all.length);
    const query = new URLSearchParams({ limit: String(page), ...cursor });
    const batch = await api(`/channels/${channelId}/messages?${query}`);
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < page) break;
    // Discord returns newest-first; with `after` the next page continues from the newest.
    cursor = after
      ? { after: batch.reduce((a, m) => (BigInt(m.id) > BigInt(a) ? m.id : a), batch[0].id) }
      : { before: batch[batch.length - 1].id };
  }
  return all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** A db message's JSON: inline after "DB:", or the db.json attachment. Null if it holds none. */
async function readDb(m) {
  const attachment = m.attachments?.find((a) => a.filename === "db.json");
  if (attachment) {
    const res = await fetch(attachment.url);
    if (!res.ok) fail(`Couldn't download db.json from ${m.id} (HTTP ${res.status})`);
    return res.json();
  }
  const line = m.content?.split("\n").find((l) => l.startsWith("DB:"));
  if (!line || line.includes("@db.json")) return null;
  try {
    return JSON.parse(line.slice(3).trim());
  } catch {
    return null;
  }
}

/** Print one message the way it reads in Discord, including what an empty-looking one carries. */
function printMessage(m) {
  const who = `${m.author.username}${m.author.bot ? " [bot]" : ""}`;
  const reply = m.message_reference && m.message_reference.type !== 1
    ? ` ↪ reply to ${m.message_reference.message_id}` : "";
  console.log(`--- ${m.timestamp} ${who} (${m.id})${reply}`);
  if (m.content) console.log(m.content);
  printParts(m, "  ");

  // A forward has empty content; what was forwarded lives in message_snapshots.
  for (const snap of m.message_snapshots ?? []) {
    const src = m.message_reference;
    console.log(`  [forwarded from channel ${src?.channel_id} message ${src?.message_id}]`);
    if (snap.message?.content) console.log(snap.message.content.replace(/^/gm, "  > "));
    printParts(snap.message ?? {}, "  > ");
  }
}

function printParts(m, indent) {
  for (const a of m.attachments ?? []) console.log(`${indent}[attachment] ${a.filename} ${a.url}`);
  for (const s of m.sticker_items ?? []) console.log(`${indent}[sticker] ${s.name}`);
  for (const e of m.embeds ?? []) {
    const fields = (e.fields ?? []).map((f) => `\n${indent}    ${f.name}: ${f.value.replace(/\n/g, " | ")}`).join("");
    console.log(`${indent}[embed] ${e.title ?? ""} ${(e.description ?? "").slice(0, 400)}${fields}`);
  }
}

function readContent(file) {
  const content = fs.readFileSync(file, "utf8").trim();
  if (!content) fail(`${file} is empty`);
  if (content.length > 2000) fail(`${file} is ${content.length} characters — Discord's cap is 2000`);
  return content;
}

async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) fail(`${init.method ?? "GET"} ${path} → HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  return { positional, flags };
}

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

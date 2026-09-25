import { ChannelType } from "discord.js";
import { getTodayPrettyDate, getTomorrowPrettyDate, toEstDateString } from "../../util/dateUtils.js";
import { getDb, defaultDb } from "./db.js";
import "dotenv/config";

/** Heads every rotation log message, and is how `rotatedToday` recognizes one. */
const ROTATION_TITLE = "🎁 Gift Rotator";

/**
 * Read the giftee (selectable) and gifter (always gifts, never selected) rosters from the
 * db, deduped and with incomplete entries dropped. Falls back to the seeded defaults per
 * list, so a db written before the rosters moved in there still rotates the original pool;
 * an explicitly empty list is honoured, since that's someone having removed everyone.
 * @param {import('discord.js').Client} client
 * @returns {Promise<{ giftees: Array<{id: string, channel: string, name?: string}>, gifters: Array<{id: string, channel: string, name?: string}> }>}
 */
export async function getGiftPools(client) {
  return poolsFromDb((await getDb(client)) ?? defaultDb());
}

/** getGiftPools' body, split out so a caller that already has the db doesn't refetch it. */
export function poolsFromDb(db) {
  const rotation = db?.giftRotation ?? {};
  const seed = defaultDb().giftRotation;
  return {
    giftees: dedupePool(Array.isArray(rotation.giftees) ? rotation.giftees : seed.giftees),
    gifters: dedupePool(Array.isArray(rotation.gifters) ? rotation.gifters : seed.gifters),
  };
}

/**
 * Set a flag to skip the next scheduled gift rotation.
 * @param {import('discord.js').Client} client
 */
export async function setSkipNextRotation(client) {
  const rotationChannelId = process.env.GIFT_ROTATION_CHANNEL_ID;
  const rotChan = await client.channels.fetch(rotationChannelId).catch(() => null);
  if (!isTextish(rotChan)) throw new Error(`Rotation channel ${rotationChannelId} not found.`);

  // Get the current state and add skip flag to it
  const lastMsg = await fetchLastMessage(rotChan);
  const lastState = parseStateFromMessage(lastMsg?.content);

  const newState = {
    remaining: lastState?.remaining || [],
    pool: lastState?.pool || [],
    skip: true,
    ts: Date.now()
  };

  await rotChan.send("⏭️ **SKIP FLAG SET** - The next scheduled rotation will be skipped. STATE: " + JSON.stringify(newState));
}

/**
 * Check if the next rotation should be skipped.
 * @param {import('discord.js').Client} client
 * @returns {Promise<boolean>}
 */
export async function shouldSkipRotation(client) {
  const rotationChannelId = process.env.GIFT_ROTATION_CHANNEL_ID;
  const rotChan = await client.channels.fetch(rotationChannelId).catch(() => null);
  if (!isTextish(rotChan)) return false;

  const lastMsg = await fetchLastMessage(rotChan);
  const lastState = parseStateFromMessage(lastMsg?.content);

  return lastState?.skip === true;
}

/**
 * Whether a rotation has already been posted today (America/New_York).
 *
 * Only the startup catch-up needs this. Every other scheduled job answers "is this already
 * done?" from Discord or the db as a matter of course, so re-firing a slot the process was
 * down for costs nothing; a rotation pick is the exception — running it twice consumes two
 * giftees out of one cycle. The evidence is the rotation log message's own timestamp rather
 * than the STATE line's `ts`, which /gift-skip stamps too.
 *
 * Fails *closed*: a channel that can't be read reports the rotation as already run, so an
 * unreadable channel can never turn into a double pick. The regularly scheduled run is
 * unaffected — it has always just attempted the rotation.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<boolean>}
 */
export async function rotatedToday(client) {
  const rotChan = await client.channels.fetch(process.env.GIFT_ROTATION_CHANNEL_ID).catch(() => null);
  if (!isTextish(rotChan)) return true;

  const msgs = await rotChan.messages.fetch({ limit: 20 }).catch(() => null);
  if (!msgs) return true;

  const today = toEstDateString(new Date());
  return [...msgs.values()].some(
    msg => msg.content.startsWith(ROTATION_TITLE) && toEstDateString(msg.createdAt) === today
  );
}

/**
 * Read the rotation cycle STATE (who's left to be picked this cycle) from the rotation
 * channel's last message, normalized against the current giftee roster. Used by
 * /gift-pool view to show the live cycle alongside the rosters.
 * @param {import('discord.js').Client} client
 * @returns {Promise<{ remaining: string[], skip: boolean }>}
 */
export async function getRotationState(client) {
  const { giftees } = await getGiftPools(client);
  const gifteeIds = new Set(giftees.map(g => g.id));

  const rotChan = await client.channels.fetch(process.env.GIFT_ROTATION_CHANNEL_ID).catch(() => null);
  if (!isTextish(rotChan)) return { remaining: [...gifteeIds], skip: false };

  const lastState = parseStateFromMessage((await fetchLastMessage(rotChan))?.content);
  const remaining = (lastState?.remaining ?? []).filter(id => gifteeIds.has(id));
  // An empty (or fully stale) remaining list means the cycle resets on the next pick.
  return { remaining: remaining.length ? remaining : [...gifteeIds], skip: lastState?.skip === true };
}

/**
 * Post a new gift rotation pick.
 * - Only giftees can be selected.
 * - Gifters this round = (giftees minus chosen) + the gifter roster.
 * - Rotation STATE only tracks giftees.
 * @param {import('discord.js').Client} client
 * @param {{ debug?: boolean }} [opts]
 */
export async function runGiftRotation(client, opts = {}) {
  const { debug = false } = opts;
  const title = ROTATION_TITLE;
  const rotationChannelId = process.env.GIFT_ROTATION_CHANNEL_ID;

  // Not swallowed: the rosters live in the db now, so a db that can't be read must abort
  // the rotation rather than quietly fall back to the seeded pool and post the wrong one.
  const db = (await getDb(client)) ?? defaultDb();
  const gifs = db.giftRotation?.gifs?.length ? db.giftRotation.gifs : defaultDb().giftRotation.gifs;

  // 1) Validate inputs
  const { giftees: validPool, gifters: exemptPool } = poolsFromDb(db);
  if (validPool.length === 0) {
    throw new Error("Giftee roster is empty. Add someone with /gift-pool add.");
  }

  // 2) Resolve rotation/log channel
  const rotChan = await client.channels.fetch(rotationChannelId).catch(() => null);
  if (!isTextish(rotChan)) throw new Error(`Rotation channel ${rotationChannelId} not found or not a text/thread channel.`);
  const guild = rotChan.guild ?? null;

  // 3) Load state and normalize against the current giftee roster (only giftees cycle)
  const lastMsg = await fetchLastMessage(rotChan);
  const lastState = parseStateFromMessage(lastMsg?.content);

  const poolIds = new Set(validPool.map(x => x.id)); // ONLY giftees are in the cycle
  let remaining = (lastState?.remaining ?? []).filter(id => poolIds.has(id));
  if (remaining.length === 0) remaining = [...poolIds];

  // 4) Choose from the giftees left this cycle
  const chosenId = randomFromArray(remaining);
  remaining = remaining.filter(id => id !== chosenId);

  // 5) Build references
  const chosen = validPool.find(p => p.id === chosenId);
  if (!chosen) throw new Error("Chosen user not found in the giftee roster after normalization.");

  const chosenRef = await formatUserRef(chosen, guild);

  // Gifters this round = (giftees minus chosen) + the gifter roster
  const gifters = [
    ...validPool.filter(p => p.id !== chosenId),
    ...exemptPool,
  ];

  const giftersRefs = await Promise.all(gifters.map(p => formatUserRef(p, guild)));
  const giftersLine = giftersRefs.join(", ") || "—";

  // 6) Post rotation log with updated STATE (giftees only)
  const state = { remaining, pool: [...poolIds], ts: Date.now() };
  const remainingRefs = await Promise.all(
    remaining.map(id => {
      const p = validPool.find(x => x.id === id);
      return formatUserRef(p, guild);
    })
  );
  const remainingLine = remainingRefs.join(", ") || "— (cycle resets next pick)";

  const exemptRefs = await Promise.all(exemptPool.map(p => formatUserRef(p, guild)));
  const exemptLine = exemptRefs.length ? exemptRefs.join(", ") : "—";

  const logLines = [
    title,
    `**Chosen:** ${chosenRef}`,
    `**Remaining this cycle (giftees):** ${remainingLine}`,
    `**Exempt gifters (not selectable):** ${exemptLine}`,
    "",
    `Debug mode: ${debug ? "✅ ON (not posting in user channel)" : "❌ OFF"}`,
    "",
    "STATE: " + JSON.stringify(state), // machine-readable for the next run
  ];
  await rotChan.send(logLines.join("\n"));

  // 7) Announce in chosen user's channel (unless debug)
  if (!debug) {
    const chosenChan = await client.channels.fetch(chosen.channel).catch(() => null);
    if (!isTextish(chosenChan)) {
      await rotChan.send(`⚠️ Could not post in <#${chosen.channel}> for ${chosenRef}. Please check permissions or channel ID.`);
      return;
    }

    const tomorrowDate = getTomorrowPrettyDate(); // UTC today = EST tomorrow
    const announceLines = [
      `🎁 **Gift Rotation**`,
      `📅 This rotation is for **${tomorrowDate}**.`,
      "",
      `**Selected:** ${chosenRef}`,
      `Everyone send your gifts to ${chosenRef}!`,
      "",
      `**Instructions:**`,
      `1. If giftee is not gold locked, gift any duplicates giftee is missing`,
      `2. If gifter has no duplicates giftee is missing and giftee is still not gold locked, gift any 1, 2, or 3 star duplicate with highest to lowest star priority to contribute to giftee's vault growth`,
      `3. When giftee is gold locked, gift any 1, 2, or 3 star duplicate with highest to lowest star priority to contribute to giftee's vault growth`,
      `4. Always gift 5 stickers`,
      "",
      `**Gifters this round:** ${giftersLine}`, // includes exempt + pool (minus chosen)
      "",
      randomFromArray(gifs),
    ];
    await chosenChan.send(announceLines.join("\n"));
  } else {
    console.log(`🧪 [DEBUG] Would have posted in ${chosen.channel} for ${chosen.name || chosen.id}`);
  }
}

/* ========================= Helpers ========================= */

function dedupePool(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    if (!x?.id || !x?.channel) continue;
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push({ id: x.id, channel: x.channel, name: x.name });
  }
  return out;
}

function isTextish(chan) {
  return !!chan && (
    chan.type === ChannelType.GuildText ||
    chan.type === ChannelType.PublicThread ||
    chan.type === ChannelType.PrivateThread
  );
}

async function fetchLastMessage(channel) {
  const msgs = await channel.messages.fetch({ limit: 1 }).catch(() => null);
  if (!msgs || msgs.size === 0) return null;
  return [...msgs.values()][0];
}

function parseStateFromMessage(content) {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  const stateLine = lines.find(l => l.trim().startsWith("STATE:"));
  if (!stateLine) return null;
  const json = stateLine.replace(/^STATE:\s*/i, "").trim();
  try {
    const obj = JSON.parse(json);
    if (!Array.isArray(obj?.remaining)) return null;
    return obj;
  } catch {
    return null;
  }
}

function randomFromArray(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function formatUserRef(entry, guild) {
  if (!entry) return "Unknown";
  const { id, name, channel } = entry;

  if (isSnowflake(id) && guild) {
    const cached = guild.members.cache.get(id);
    if (cached) return `<@${id}>`;
    try {
      const fetched = await guild.members.fetch(id);
      if (fetched) return `<@${id}>`;
    } catch { }
  }

  const pretty = name ? `**${name}**` : (isSnowflake(id) ? `**User ${id}**` : `**${id}**`);
  const channelRef = channel ? ` (<#${channel}>)` : "";
  return `${pretty}${channelRef}`;
}

function isSnowflake(s) {
  return typeof s === "string" && /^[0-9]{17,20}$/.test(s);
}

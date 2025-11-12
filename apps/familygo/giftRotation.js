import { ChannelType } from "discord.js";
import { getTomorrowPrettyDate } from "../../util/dateUtils.js";
import "dotenv/config";

const POOL = [
  { id: process.env.ROLLER_USER_ID, channel: process.env.ROLLER_CHANNEL_ID, name: "DaRoller" },
  { id: process.env.WRECKER_USER_ID, channel: process.env.WRECKER_CHANNEL_ID, name: "DaWrecker" },
  { id: process.env.BUILDER_USER_ID, channel: process.env.BUILDER_CHANNEL_ID, name: "DaBuilder" },
  { id: process.env.COLLECTOR_USER_ID, channel: process.env.COLLECTOR_CHANNEL_ID, name: "DaCollector" },
  { id: process.env.ANCHOR_USER_ID, channel: process.env.ANCHOR_CHANNEL_ID, name: "DaAnchor" },
  { id: "oly-lifts", channel: process.env.OLY_CHANNEL_ID, name: "OlyLifts" },
  { id: "mech-e", channel: process.env.MECH_CHANNEL_ID, name: "MechE" },
  { id: "majestic-ruby-71", channel: process.env.MAJESTIC_CHANNEL_ID, name: "MajesticRuby71" },
];

/**
 * Post a new gift rotation pick.
 * @param {import('discord.js').Client} client
 * @param {boolean} [debug=false] - If true, skip posting in the chosen user’s channel
 */
export async function runGiftRotation(client, opts = {}) {
  const { debug = false } = opts;
  const title = "🎁 Gift Rotator";
  const pool = POOL;
  const rotationChannelId = process.env.GIFT_ROTATION_CHANNEL_ID;

  // 1) Validate inputs
  const validPool = dedupePool(pool);
  if (validPool.length === 0) throw new Error("Pool is empty. Provide users with { id, channel }.");

  // 2) Resolve rotation/log channel
  const rotChan = await client.channels.fetch(rotationChannelId).catch(() => null);
  if (!isTextish(rotChan)) {
    throw new Error(`Rotation channel ${rotationChannelId} not found or not a text/thread channel.`);
  }

  const guild = rotChan.guild ?? null;

  // 3) Fetch the last rotation message (state)
  const lastMsg = await fetchLastMessage(rotChan);
  const lastState = parseStateFromMessage(lastMsg?.content);

  const poolIds = new Set(validPool.map(x => x.id));
  let remaining = (lastState?.remaining ?? []).filter(id => poolIds.has(id));
  if (remaining.length === 0) remaining = [...poolIds];

  // 4) Choose randomly from remaining and compute next remaining
  const chosenId = randomFromArray(remaining);
  remaining = remaining.filter(id => id !== chosenId);

  // 5) Find chosen person + build references
  const chosen = validPool.find(p => p.id === chosenId);
  if (!chosen) throw new Error("Chosen user not found in pool (after normalization).");

  const chosenRef = await formatUserRef(chosen, guild);
  const gifters = validPool.filter(p => p.id !== chosenId);
  const giftersRefs = await Promise.all(gifters.map(p => formatUserRef(p, guild)));
  const giftersLine = giftersRefs.join(", ") || "—";

  // 6) Post rotation log with updated STATE (in rotation channel)
  const state = { remaining, pool: [...poolIds], ts: Date.now() };
  const remainingRefs = await Promise.all(
    remaining.map(id => {
      const p = validPool.find(x => x.id === id);
      return formatUserRef(p, guild);
    })
  );
  const remainingLine = remainingRefs.join(", ") || "— (cycle resets next pick)";

  const logLines = [
    title,
    `**Chosen:** ${chosenRef}`,
    `**Remaining this cycle:** ${remainingLine}`,
    "",
    `Debug mode: ${debug ? "✅ ON (not posting in user channel)" : "❌ OFF"}`,
    "",
    "STATE: " + JSON.stringify(state),
  ];
  await rotChan.send(logLines.join("\n"));

  // 7) If not in debug mode, post in the chosen user’s channel
  if (!debug) {
    const chosenChan = await client.channels.fetch(chosen.channel).catch(() => null);
    if (!isTextish(chosenChan)) {
      await rotChan.send(`⚠️ Could not post in <#${chosen.channel}> for ${chosenRef}. Please check permissions or channel ID.`);
      return;
    }

    const tomorrowDate = getTomorrowPrettyDate();

    const announceLines = [
      `🎁 **Gift Rotation**`,
      `📅 This rotation is for **${tomorrowDate}**.`,
      "",
      `**Selected:** ${chosenRef}`,
      `Everyone send your gifts to ${chosenRef}!`,
      "",
      `**Gifters this round:** ${giftersLine}`,
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

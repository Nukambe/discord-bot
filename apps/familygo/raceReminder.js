import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from "discord.js";
import { toEstDateString, toEstTimeParts } from "../../util/dateUtils.js";
import { getDb, defaultDb, getLastPosts, updateLastPosts } from "./db.js";
import { poolsFromDb } from "./giftRotation.js";

/** customId prefix of a reminder's Yes button: `race-confirm:<startedAt>:<person id>`. */
export const RACE_CONFIRM_PREFIX = "race-confirm:";

/**
 * Posted once someone presses Yes. Also how a channel is known to have confirmed: a run
 * looks for this message from the bot since the race started (see hasConfirmed), so who has
 * responded is read from Discord rather than kept in the db.
 */
const THANK_YOU = "### Thank you for joining your team! Let’s get those flags <:RaceCup_Currency_Icon:1441936191870992454>!";

/**
 * The reminders, in order, worded exactly as requested. `dayOffset` counts from the ET day
 * /race-reminder start was run; times are ET.
 */
export const RACE_REMINDER_STEPS = [
  { dayOffset: 0, hour: 17, minute: 0, heading: "### Time to join your racers 🏎️ team!" },
  { dayOffset: 0, hour: 21, minute: 0, heading: "### Hurry! Don’t wait any longer to join your racers 🏎️ team!" },
  { dayOffset: 1, hour: 9, minute: 0, heading: "### Your racers 🏎️ team is waiting impatiently for you to join‼️" },
  {
    dayOffset: 1,
    hour: 12,
    minute: 0,
    heading: "### 🚨 What have you waited this long for 🤨⁉️ Join your racers team IMMEDIATELY or get left in the dust 🏎️💨‼️",
  },
];

/**
 * Start a race: everyone on the gift-rotation rosters (giftees and gifters — each has a
 * channel of their own) gets the reminders, beginning at the first step's time today.
 *
 * Stored as db.lastPosts.raceReminder `{ startedAt, date, step, people }` — written through
 * updateLastPosts so it doesn't rebuild the schedule, which never changes: the job's slots
 * are the four step times every day, and each run decides from this state whether one is
 * due. `people` is a snapshot, so a roster edit mid-race doesn't change who's reminded.
 * Starting again replaces whatever race was running.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<{ race: object, replaced: object|null }>} the new race, and the one it
 *   replaced if that one still had reminders left to send.
 */
export async function startRaceReminders(client) {
  // Not swallowed: an unreadable db must not quietly remind the seeded roster instead.
  const db = (await getDb(client)) ?? defaultDb();
  const { giftees, gifters } = poolsFromDb(db);

  const seenChannels = new Set();
  const people = [];
  for (const { id, channel, name } of [...giftees, ...gifters]) {
    if (seenChannels.has(channel)) continue;
    seenChannels.add(channel);
    people.push({ id, channel, name });
  }
  if (!people.length) throw new Error("The gift rotation rosters are empty — nobody to remind.");

  const previous = db.lastPosts?.raceReminder ?? null;
  const now = new Date();
  const race = { startedAt: now.getTime(), date: toEstDateString(now), step: -1, people };
  if (!(await updateLastPosts(client, { raceReminder: race }))) {
    throw new Error("Couldn't save the race reminder to the db.");
  }

  const replaced = previous && previous.step < RACE_REMINDER_STEPS.length - 1 ? previous : null;
  return { race, replaced };
}

/**
 * Stop the running race, if there is one. Buttons already posted keep working.
 * @param {import('discord.js').Client} client
 * @returns {Promise<boolean>} whether a race was running.
 */
export async function stopRaceReminders(client) {
  const { raceReminder } = await getLastPosts(client);
  if (!raceReminder) return false;
  if (!(await updateLastPosts(client, { raceReminder: null }))) {
    throw new Error("Couldn't clear the race reminder in the db.");
  }
  return true;
}

/**
 * Send the race's latest reminder whose time has come, if it hasn't gone out yet — to every
 * channel whose owner hasn't pressed Yes since the race started.
 *
 * Only the *latest* due step is sent, so a race started at 10pm opens with the 9pm reminder
 * rather than firing two at once, and a bot that was off over a slot sends where the race
 * is now rather than catching up on each reminder it missed. The recorded `step` is what
 * makes a second run for the same slot (the startup catch-up, or /race-reminder start
 * running this straight away) a no-op. Nothing goes out after the day following the start.
 *
 * @param {import('discord.js').Client} client
 * @param {Date} [now]
 * @returns {Promise<{ step: number, sent: number, confirmed: number, failed: string[] }|null>}
 *   null when nothing was due.
 */
export async function sendDueRaceReminder(client, now = new Date()) {
  const race = (await getLastPosts(client)).raceReminder;
  if (!race?.people?.length) return null;

  const step = dueStep(race, now);
  if (step === null || step <= race.step) return null;
  const { heading } = RACE_REMINDER_STEPS[step];
  console.log(`🏎️ Sending race reminder ${step + 1}/${RACE_REMINDER_STEPS.length} (race started ${race.date})`);

  let sent = 0;
  let confirmed = 0;
  const failed = [];
  for (const person of race.people) {
    const label = person.name || person.id;
    try {
      const channel = await client.channels.fetch(person.channel).catch(() => null);
      if (!channel?.isTextBased?.()) throw new Error(`channel ${person.channel} not found`);
      if (await hasConfirmed(channel, race.startedAt, client.user.id)) {
        confirmed++;
        continue;
      }
      await channel.send({
        content: `${heading}\n${personRef(person)} Click yes to confirm that you have joined your team.`,
        components: [confirmRow(race.startedAt, person.id)],
      });
      sent++;
    } catch (err) {
      console.error(`💥 Couldn't send the race reminder to ${label}:`, err?.message || err);
      failed.push(label);
    }
  }
  console.log(`🏁 Race reminder ${step + 1}: ${sent} sent, ${confirmed} already confirmed, ${failed.length} failed`);

  // Re-read before recording, so a race started while this one was sending isn't overwritten.
  const latest = (await getLastPosts(client)).raceReminder;
  if (latest?.startedAt === race.startedAt) {
    await updateLastPosts(client, { raceReminder: { ...latest, step } });
  }
  return { step, sent, confirmed, failed };
}

/**
 * A Yes press: take the button off this race's reminders in the channel and post the
 * thank-you. A reminder for a real user can only be confirmed by them (or an admin); one for
 * a member who only exists as a channel can be confirmed by anyone who can see it.
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleRaceConfirm(interaction) {
  const [startedAtText, personId] = interaction.customId.slice(RACE_CONFIRM_PREFIX.length).split(":");
  const startedAt = Number(startedAtText);

  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  if (isSnowflake(personId) && interaction.user.id !== personId && !isAdmin) {
    await interaction.reply({ content: `This reminder is for <@${personId}>.`, ephemeral: true });
    return;
  }

  await interaction.update({ components: [] });

  const { channel, client } = interaction;
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const mine = messages ? [...messages.values()].filter((m) => m.author?.id === client.user.id) : [];

  // Earlier reminders of the same race still carry a button; one press answers them all.
  const racePrefix = `${RACE_CONFIRM_PREFIX}${startedAtText}:`;
  for (const msg of mine) {
    if (msg.id === interaction.message.id) continue;
    const hasButton = msg.components.some((row) => row.components?.some((c) => c.customId?.startsWith(racePrefix)));
    if (hasButton) await msg.edit({ components: [] }).catch(() => {});
  }

  // A second press (an old button, or two people at once) doesn't thank twice.
  if (mine.some((m) => isThankYou(m, startedAt))) return;
  await channel.send(THANK_YOU);
  console.log(`✅ Race team confirmed in #${channel.name ?? channel.id} by ${interaction.user.tag}`);
}

/**
 * The index of the latest step whose time has come for `race`, or null when none has yet
 * (or the race is over — past the last day it has reminders on).
 * @param {{ date: string }} race - date: the ET day the race started, "YYYY-MM-DD".
 * @param {Date} now
 * @returns {number|null}
 */
export function dueStep(race, now) {
  const today = toEstDateString(now);
  const lastDay = Math.max(...RACE_REMINDER_STEPS.map((s) => s.dayOffset));
  if (today > shiftDate(race.date, lastDay)) return null;

  const { hour, minute } = toEstTimeParts(now);
  const nowKey = `${today} ${hhmm(hour, minute)}`;
  let due = null;
  RACE_REMINDER_STEPS.forEach((s, i) => {
    if (`${shiftDate(race.date, s.dayOffset)} ${hhmm(s.hour, s.minute)}` <= nowKey) due = i;
  });
  return due;
}

/** e.g. "5:00 PM" — for replies about when a step goes out. */
export function stepTime({ hour, minute }) {
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** Whether `channel` has the bot's thank-you since the race started. */
async function hasConfirmed(channel, startedAt, botId) {
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  return !!messages && [...messages.values()].some((m) => m.author?.id === botId && isThankYou(m, startedAt));
}

function isThankYou(msg, startedAt) {
  return msg.createdTimestamp >= startedAt && msg.content?.startsWith(THANK_YOU);
}

function confirmRow(startedAt, personId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RACE_CONFIRM_PREFIX}${startedAt}:${personId}`)
      .setLabel("Yes")
      .setStyle(ButtonStyle.Success)
  );
}

/** A mention for a real user; the name for a member who only exists as a channel. */
function personRef({ id, name }) {
  return isSnowflake(id) ? `<@${id}>` : `**${name || id}**`;
}

function isSnowflake(s) {
  return typeof s === "string" && /^[0-9]{17,20}$/.test(s);
}

function hhmm(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" moved by `days` calendar days. */
function shiftDate(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(y, m - 1, d + days);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}-${String(shifted.getDate()).padStart(2, "0")}`;
}

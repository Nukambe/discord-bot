import "./logBuffer.js"; // must be first so every subsequent import's output is captured
import { Client, Collection, GatewayIntentBits, Events } from "discord.js";
import { startScheduler, atTime, windowSlots } from "./cronScheduler.js";
import { formatDateSlug, toEstDateString, toEstTimeParts } from "../../util/dateUtils.js";
import { formatMogoDiscordMessage } from "./formatEvent.js";
import { parseMonopolyEventPage } from "./getEvent.js";
import { getEventUrlFromHtml, getMogoEventPage, getMogoWikiEvents } from "./getEvents.js";
import { postEvent } from "./postEvent.js";
import { postFutureEventsToDiscord } from "./postFutureEvents.js";
import { postNewFreeDiceLinks } from "./postFreeDiceLinks.js";
import { postWeeklyPredictions } from "./postWeeklyPredictions.js";
import { postCollectibleSpoilers } from "./postCollectibleSpoilers.js";
import { loadCommands, loadCommandsFromModules } from "../../util/loadCommands.js";
import { staticCommands } from "./commands/index.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runGiftRotation, shouldSkipRotation } from "./giftRotation.js";
import { deployCommands } from "./deploy-commands.js";
import { fortuneFlipChannelListener } from "./postInstructions.js";
import { initDb, defaultDb, onDbChange, getLastPosts, updateLastPosts } from "./db.js";
import { handleConfigModalSubmit } from "./commands/config.js";
import "dotenv/config";

deployCommands();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// in-memory command registry + cooldowns
client.commands = new Collection();
const cooldowns = new Collection();

export const postEventToDiscord = async (client, dateSlug, opts = {}) => {
    // debug routes the post to TEST_CHANNEL_ID instead of the live channel, and
    // turns on the fetch-layer debug output (verbose logs + HTML dumps to disk).
    const { debug = false } = opts;

    console.log(`🌀 Starting postEventToDiscord for date: ${dateSlug}${debug ? " (debug → test channel)" : ""}`);

    // Step 0: Skip if the db already records this date as posted — this is what keeps the
    // cron and a manual /post-daily from double-posting each other's work, whichever ran
    // first. Checked before any scraping so a skipped run never opens a browser window.
    // Debug bypasses it (and never records) so a test post always goes out.
    if (!debug) {
        const lastPosts = await getLastPosts(client);
        if (lastPosts.daily === dateSlug) {
            console.log(`ℹ️ Daily post for ${dateSlug} already recorded in db — skipping`);
            return;
        }
    }

    // Step 1: Retrieve HTML
    const eventsHtml = await getMogoWikiEvents({ debug });
    if (!eventsHtml) {
        console.error("❌ Unable to retrieve HTML from Mogo Wiki");
        return;
    }
    console.log("✅ Retrieved main events HTML");

    // Step 2: Extract URL for event page
    const url = getEventUrlFromHtml(eventsHtml, dateSlug, { debug });
    if (!url) {
        console.warn(`⚠️ No event URL found for date slug: ${dateSlug}`);
        return false;
    }
    console.log(`🔗 Found event URL: ${url}`);

    // Step 3: Retrieve full event page
    const eventHtml = await getMogoEventPage(url, { debug });
    if (!eventHtml) {
        console.error(`❌ Unable to fetch event page for URL: ${url}`);
        return;
    }
    console.log("✅ Retrieved event page HTML");

    // Step 4: Parse event data
    const data = parseMonopolyEventPage(eventHtml);
    if (!data) {
        console.error("❌ Failed to parse Monopoly event page data");
        return;
    }
    console.log("🧩 Parsed event data successfully");

    // Step 5: Format message for Discord
    const formatted = formatMogoDiscordMessage(data, url);
    console.log("🖋️ Formatted message for Discord embed");
    console.log(`📦 Embeds: ${formatted.embeds.length}`);
    console.log(`🧾 Content preview:\n${formatted.content?.slice(0, 200)}...`);

    // Step 6: Post to Discord
    try {
        await postEvent({
            client,
            content: formatted.content,
            embeds: formatted.embeds,
            debug,
        });
        console.log("✅ Successfully posted event to Discord");
        if (!debug) await updateLastPosts(client, { daily: dateSlug });
    } catch (err) {
        console.error("💥 Failed to post event to Discord:", err);
    }

    console.log("🏁 Finished postEventToDiscord\n");
};

/**
 * Wire up slash command handling using client.commands
 * Each command object should export:
 *  - data: SlashCommandBuilder (with .name)
 *  - execute(interaction): Promise<void>
 *  - cooldown?: number (seconds)  [optional]
 *  - dmPermission?: boolean       [optional, used at deploy time]
 *  - defaultMemberPermissions?: PermissionFlagsBits | null [optional, used at deploy time]
 */
const listenForCommands = async (client) => {
    const { commands } = process.pkg
        ? loadCommandsFromModules(staticCommands)
        : await loadCommands(path.join(path.dirname(fileURLToPath(import.meta.url)), "commands"));
    for (const [name, cmd] of commands) client.commands.set(name, cmd);
    console.log("🧭 Command listener initialized");

    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isModalSubmit()) {
            if (!interaction.customId.startsWith("config-modal:")) return;
            try {
                await handleConfigModalSubmit(interaction);
            } catch (err) {
                console.error("💥 Error handling config modal submit:", err);
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({
                        content: "⚠️ Something went wrong updating the config.",
                        ephemeral: true,
                    }).catch(() => { });
                } else {
                    await interaction.reply({
                        content: "⚠️ Something went wrong updating the config.",
                        ephemeral: true,
                    }).catch(() => { });
                }
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        const name = interaction.commandName;
        const cmd = client.commands.get(name);

        if (!cmd || typeof cmd.execute !== "function") {
            // Unknown command (not in local registry) — avoid throwing for users
            return interaction.reply({
                content: "⚠️ Sorry, that command isn't available right now.",
                ephemeral: true,
            }).catch(() => { });
        }

        // ---- Cooldowns (per-user, per-command) ----
        try {
            if (cmd.cooldown) {
                const now = Date.now();
                // cooldowns is defined above as: new Collection()
                if (!cooldowns.has(name)) cooldowns.set(name, new Collection());
                const timestamps = cooldowns.get(name);
                const cooldownMs = cmd.cooldown * 1000;

                const last = timestamps.get(interaction.user.id) || 0;
                const expires = last + cooldownMs;

                if (now < expires) {
                    const remaining = Math.ceil((expires - now) / 1000);
                    return interaction.reply({
                        content: `⏳ Please wait **${remaining}s** before using \`/${name}\` again.`,
                        ephemeral: true,
                    });
                }

                timestamps.set(interaction.user.id, now);
                setTimeout(() => {
                    // auto-clean after window
                    const t = cooldowns.get(name);
                    if (t) t.delete(interaction.user.id);
                }, cooldownMs).unref?.();
            }
        } catch (e) {
            console.warn("Cooldown handling error:", e);
            // proceed anyway
        }

        // ---- Execute command ----
        try {
            await cmd.execute(interaction);
        } catch (err) {
            console.error(`💥 Error executing /${name}:`, err);
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({
                    content: "⚠️ Something went wrong while running that command.",
                    ephemeral: true,
                }).catch(() => { });
            } else {
                await interaction.reply({
                    content: "⚠️ Something went wrong while running that command.",
                    ephemeral: true,
                }).catch(() => { });
            }
        }
    });

    fortuneFlipChannelListener(client);
};

/**
 * Check if today's event post already exists in the Discord channel.
 * Uses the message content (`source: <url>`) which always contains the dateSlug.
 */
const isAlreadyPosted = async (client, dateSlug) => {
    const channelId = process.env.CHANNEL_ID;
    if (!channelId) return false;
    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return false;
        const messages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
        if (!messages) return false;
        return messages.some(msg => msg.content?.includes(dateSlug));
    } catch {
        return false;
    }
};

/**
 * Parse a "HH:mm" (24h) string into [hour, minute], falling back if missing/invalid.
 */
const parseHHmm = (str, fallbackHour, fallbackMinute) => {
    const match = typeof str === "string" && str.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return [hour, minute];
    }
    return [fallbackHour, fallbackMinute];
};

/** Handle for the live cron tasks, torn down and rebuilt when the config changes. */
let scheduler = null;

/**
 * Every scheduled familygo job.
 *
 * Each one declares the minutes it wants to run at rather than owning a cron of
 * its own; cronScheduler.js buckets those declarations and registers one cron
 * task per distinct fire time. Jobs run in the order listed below whenever a
 * slot holds more than one of them, and never concurrently — which matters
 * because most of these scrape the wiki, and every wiki fetch opens a *visible*
 * Chrome window on the packaged desktop build (Cloudflare rejects headless, see
 * util/fetchWithPlaywright.js). The gift rotation leads because it's the only
 * one that needs no browser, so it shouldn't queue behind three that do.
 *
 * All slots are America/New_York regardless of host timezone.
 */
const JOBS = [
    /**
     * Gift rotation: the configured time on the configured days (default 7:30pm
     * ET, Sundays and Wednesdays). Honours the /config pause window and the
     * one-shot admin skip flag, both of which live in the rotation channel.
     */
    {
        name: "gift-rotation",
        slots: ({ db }) => {
            const [hour, minute] = parseHHmm(db.giftRotation?.time, 19, 30);
            const days = db.giftRotation?.days?.length ? db.giftRotation.days : [0, 3];
            return atTime(hour, minute, days);
        },
        run: async ({ client, db }) => {
            console.log("🎁 Running gift rotation...");

            // Pause window (configured via /config gift-rotation-pause)
            const pause = db.giftRotation?.pause;
            if (pause?.start && pause?.end) {
                const nowEst = toEstDateString(new Date());
                if (nowEst >= pause.start && nowEst <= pause.end) {
                    console.log(`⏸️ Gift rotation paused (${pause.start}–${pause.end} pause window). Skipping.`);
                    return;
                }
            }

            // Check if rotation should be skipped
            const skip = await shouldSkipRotation(client);
            if (!skip) {
                await runGiftRotation(client);
                console.log("✅ Gift rotation job completed.");
                return;
            }

            console.log("⏭️ Gift rotation skipped by admin command. Will resume next time.");

            // Clear the skip flag without changing the rotation state
            const rotationChannelId = process.env.GIFT_ROTATION_CHANNEL_ID;
            const rotChan = await client.channels.fetch(rotationChannelId).catch(() => null);
            if (!rotChan) return;

            // Read current state and repost without skip flag
            const msgs = await rotChan.messages.fetch({ limit: 1 }).catch(() => null);
            if (!msgs || msgs.size === 0) return;
            const lastMsg = [...msgs.values()][0];
            const lines = lastMsg.content.split(/\r?\n/);
            const stateLine = lines.find(l => l.trim().startsWith("STATE:"));
            if (!stateLine) return;

            const json = stateLine.replace(/^STATE:\s*/i, "").trim();
            try {
                const state = JSON.parse(json);
                delete state.skip; // Remove skip flag
                state.ts = Date.now(); // Update timestamp
                await rotChan.send("✅ Skip consumed. Next rotation will run normally. STATE: " + JSON.stringify(state));
            } catch (e) {
                console.error("Failed to parse state while clearing skip:", e);
            }
        },
    },

    /**
     * Daily events post: first attempt at the configured window start, retrying
     * every `retryIntervalMinutes` until the window closes the next day (default
     * 7:30pm → 3:30pm ET, every 30 minutes). Every day opens its own window, so
     * the slots cover both the evening half and the following morning's spill.
     *
     * Discord is the persistence layer — the run re-checks whether the post is
     * already there — so a restart mid-window resumes the retry loop untouched.
     */
    {
        name: "daily-post",
        slots: ({ db }) => {
            const [startHour, startMinute] = parseHHmm(db.dailyPost?.windowStartTime, 19, 30);
            const [endHour, endMinute] = parseHHmm(db.dailyPost?.windowEndTime, 15, 30);
            return windowSlots({
                startHour,
                startMinute,
                endHour,
                endMinute,
                intervalMinutes: db.dailyPost?.retryIntervalMinutes || 30,
            });
        },
        run: async ({ client, db }) => {
            const [startHour, startMinute] = parseHHmm(db.dailyPost?.windowStartTime, 19, 30);

            // Get current time components in Eastern
            const now = new Date();
            const [estYear, estMonth, estDay] = toEstDateString(now).split('-').map(Number);
            const { hour: estHour, minute: estMinute } = toEstTimeParts(now);

            // Which side of midnight the slot sits on decides the target date:
            // tomorrow's events from the window's opening evening, today's from
            // the retries that spill past midnight.
            const afterWindowStart = estHour > startHour || (estHour === startHour && estMinute >= startMinute);
            const targetDate = new Date(estYear, estMonth - 1, estDay);
            if (afterWindowStart) targetDate.setDate(targetDate.getDate() + 1);
            const dateSlug = formatDateSlug(targetDate);

            // Skip if already posted (Discord is the persistence layer)
            if (await isAlreadyPosted(client, dateSlug)) return;

            console.log(`📅 Attempting to post event for ${dateSlug}...`);
            await postEventToDiscord(client, dateSlug);
        },
    },

    /**
     * Free-dice links: one run daily at 7:30pm ET. The today+yesterday window
     * inside postNewFreeDiceLinks means a link published after 7:30pm is still
     * caught by the next evening's run, and deduping against the channel makes
     * the overlapping windows (and any manual /free-dice in between) safe.
     */
    {
        name: "free-dice",
        slots: () => atTime(19, 30),
        run: async ({ client }) => {
            console.log("🎲 Running daily 7:30pm free-dice link check...");
            await postNewFreeDiceLinks(client);
        },
    },

    /**
     * Collectible spoilers: one run nightly at 7:30pm ET, sharing the slot with the
     * daily post window and the free-dice check — the shared scheduler runs the three
     * in JOBS order rather than at once, so only one browser window is ever open.
     *
     * The wiki dates none of its collectibles, so unlike the other jobs this one can't
     * ask Discord "is this already there?" — it compares against the item ids remembered
     * in db.lastPosts.spoilers (see postCollectibleSpoilers.js).
     */
    {
        name: "collectible-spoilers",
        slots: () => atTime(19, 30),
        run: async ({ client }) => {
            console.log("👀 Running nightly 7:30pm collectible spoilers check...");
            await postCollectibleSpoilers(client);
        },
    },

    /**
     * Weekly predictions: Sundays at 7:30pm ET, posting the upcoming Monday–
     * Sunday schedule from the wiki's /events calendar. Retries every 30 minutes
     * through Monday 3:30pm, because postWeeklyPredictions bails when the
     * calendar doesn't cover the full target week yet. Both dedupe layers are
     * checked before any scraping, so the ticks after a successful post cost no
     * browser window.
     */
    {
        name: "weekly-predictions",
        slots: () => windowSlots({
            startHour: 19,
            startMinute: 30,
            endHour: 15,
            endMinute: 30,
            intervalMinutes: 30,
            days: [0], // window opens Sunday evening, spills into Monday
        }),
        run: async ({ client }) => {
            console.log("🔮 Attempting weekly predictions post...");
            await postWeeklyPredictions(client);
        },
    },

    /**
     * Wiki news sweep: once nightly at 7:30pm ET in the shared slot, after the
     * jobs above. Posts every article the news index lists after the wiki's
     * newest "Today's Events" post that the previous run stopped at, so a day's
     * worth is measured by the wiki's own day markers rather than by calendar
     * dates (see selectPostsSinceMarker in getFutureEvents.js).
     *
     * Deliberately once a day, not a repeating sweep: run count is a UX budget
     * on the packaged desktop build, where each run opens a visible browser
     * window. Anything the wiki publishes after 7:30pm is picked up by the next
     * evening's run (the cutoff only moves when a run resolves everything), or
     * sooner by a manual /future-events, which posts only what this run didn't.
     */
    {
        name: "future-events",
        slots: () => atTime(19, 30),
        run: async ({ client }) => {
            console.log("📰 Running nightly 7:30pm wiki news sweep...");
            await postFutureEventsToDiscord(client);
        },
    },
];

client.once(Events.ClientReady, async () => {
    console.log(`✅ Discord ready as ${client.user.tag}`);

    let db;
    try {
        db = await initDb(client);
    } catch (err) {
        console.error("💥 Failed to initialize database:", err);
        db = defaultDb();
    }

    scheduler = startScheduler(JOBS, { client, db });

    // Whenever a command updates the db, resolve every job's fire times against
    // the new config and re-register the whole set — job times can merge or
    // split apart as the schedule changes, so the tasks are rebuilt wholesale
    // rather than patched.
    onDbChange((newDb) => {
        console.log("🔄 Database updated — rebuilding cron schedule...");
        scheduler?.stop();
        scheduler = startScheduler(JOBS, { client, db: newDb });
    });

    await listenForCommands(client);
});

// graceful shutdown
const shutdown = async (sig) => {
    console.log(`Received ${sig}, logging out...`);
    try { await client.destroy(); } catch { }
    process.exit(0);
};
["SIGTERM", "SIGINT"].forEach(s => process.on(s, () => shutdown(s)));

client.login(process.env.DISCORD_TOKEN);

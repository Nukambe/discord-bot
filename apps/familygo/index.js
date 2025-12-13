import { Client, Collection, GatewayIntentBits, Events } from "discord.js";
import cron from 'node-cron';
import { formatDateSlug } from "../../util/dateUtils.js";
import { formatMogoDiscordMessage } from "./formatEvent.js";
import { parseMonopolyEventPage } from "./getEvent.js";
import { getEventUrlFromHtml, getMogoEventPage, getMogoWikiEvents } from "./getEvents.js";
import { postEvent } from "./postEvent.js";
import { loadCommands } from "../../util/loadCommands.js";
import path from "node:path";
import { runGiftRotation, shouldSkipRotation } from "./giftRotation.js";
import { deployCommands } from "./deploy-commands.js";
import { fortuneFlipChannelListener } from "./postInstructions.js";
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

export const postEventToDiscord = async (client, dateSlug) => {
    console.log(`🌀 Starting postEventToDiscord for date: ${dateSlug}`);

    // Step 1: Retrieve HTML
    const eventsHtml = await getMogoWikiEvents();
    if (!eventsHtml) {
        console.error("❌ Unable to retrieve HTML from Mogo Wiki");
        return;
    }
    console.log("✅ Retrieved main events HTML");

    // Step 2: Extract URL for event page
    const url = getEventUrlFromHtml(eventsHtml, dateSlug);
    if (!url) {
        console.warn(`⚠️ No event URL found for date slug: ${dateSlug}`);
        return;
    }
    console.log(`🔗 Found event URL: ${url}`);

    // Step 3: Retrieve full event page
    const eventHtml = await getMogoEventPage(url);
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
        });
        console.log("✅ Successfully posted event to Discord");
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
    const commandsPath = path.resolve("apps/familygo/commands");
    const { commands } = await loadCommands(commandsPath);
    for (const [name, cmd] of commands) client.commands.set(name, cmd);
    console.log("🧭 Command listener initialized");

    client.on(Events.InteractionCreate, async (interaction) => {
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

client.once(Events.ClientReady, async () => {
    console.log(`✅ Discord ready as ${client.user.tag}`);

    // Run daily job at 7:30 PM Eastern Time
    cron.schedule(
        '30 19 * * *',
        async () => {
            console.log('Running daily script (7:30 PM EST)...');
            const dateSlug = formatDateSlug(new Date());
            await postEventToDiscord(client, dateSlug);
        },
        { timezone: 'America/New_York' }
    );
    // Gift rotation: every Tuesday (2) and Saturday (6) at 7:30 PM Eastern
    cron.schedule(
        "30 19 * * 0,3", // minute hour day month dayOfWeek (0=Sun, 3=Wed)
        async () => {
            console.log("🎁 Running gift rotation (Sun/Wed 7:30 PM EST)...");

            try {
                // Check if rotation should be skipped
                const skip = await shouldSkipRotation(client);
                if (skip) {
                    console.log("⏭️ Gift rotation skipped by admin command. Will resume next time.");

                    // Clear the skip flag without changing the rotation state
                    const rotationChannelId = process.env.GIFT_ROTATION_CHANNEL_ID;
                    const rotChan = await client.channels.fetch(rotationChannelId).catch(() => null);
                    if (rotChan) {
                        // Read current state and repost without skip flag
                        const msgs = await rotChan.messages.fetch({ limit: 1 }).catch(() => null);
                        if (msgs && msgs.size > 0) {
                            const lastMsg = [...msgs.values()][0];
                            const lines = lastMsg.content.split(/\r?\n/);
                            const stateLine = lines.find(l => l.trim().startsWith("STATE:"));
                            if (stateLine) {
                                const json = stateLine.replace(/^STATE:\s*/i, "").trim();
                                try {
                                    const state = JSON.parse(json);
                                    delete state.skip; // Remove skip flag
                                    state.ts = Date.now(); // Update timestamp
                                    await rotChan.send("✅ Skip consumed. Next rotation will run normally. STATE: " + JSON.stringify(state));
                                } catch (e) {
                                    console.error("Failed to parse state while clearing skip:", e);
                                }
                            }
                        }
                    }
                    return;
                }

                await runGiftRotation(client);
                console.log("✅ Gift rotation job completed.");
            } catch (err) {
                console.error("💥 Gift rotation job failed:", err);
            }
        },
        { timezone: "America/New_York" }
    );
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

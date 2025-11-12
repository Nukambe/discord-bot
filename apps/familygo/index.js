import { Client, Collection, GatewayIntentBits, Events } from "discord.js";
import cron from 'node-cron';
import { getTomorrowSlug } from "../../util/dateUtils.js";
import { formatMogoDiscordMessage } from "./formatEvent.js";
import { parseMonopolyEventPage } from "./getEvent.js";
import { getEventUrlFromHtml, getMogoEventPage, getMogoWikiEvents } from "./getEvents.js";
import { postEvent } from "./postEvent.js";
import { loadCommands } from "../../util/loadCommands.js";
import path from "node:path";
import "dotenv/config";

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

const postEventToDiscord = async (client, dateSlug) => {
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
    const formatted = formatMogoDiscordMessage(data);
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
};

client.once(Events.ClientReady, async () => {
    console.log(`✅ Discord ready as ${client.user.tag}`);

    // Run daily job at 7:30 PM Eastern Time
    cron.schedule(
        '30 19 * * *',
        async () => {
            console.log('Running daily script (7:30 PM EST)...');
            const dateSlug = getTomorrowSlug();
            await postEventToDiscord(client, dateSlug);
        },
        { timezone: 'America/New_York' }
    );
    // Gift rotation: every Tuesday (2) and Saturday (6) at 7:30 PM Eastern
    cron.schedule(
        "30 19 * * 2,6", // minute hour day month dayOfWeek (0=Sun, 2=Tue, 6=Sat)
        async () => {
            console.log("🎁 Running gift rotation (Tue/Sat 7:30 PM EST)...");

            try {
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

client.on(Events.MessageCreate, (m) => {
    if (m.author.bot) return;
    if (m.content.trim() === "!ping") m.reply("Pong!");
});

// graceful shutdown
const shutdown = async (sig) => {
    console.log(`Received ${sig}, logging out...`);
    try { await client.destroy(); } catch { }
    process.exit(0);
};
["SIGTERM", "SIGINT"].forEach(s => process.on(s, () => shutdown(s)));

client.login(process.env.DISCORD_TOKEN);

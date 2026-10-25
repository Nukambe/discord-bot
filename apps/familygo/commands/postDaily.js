import { SlashCommandBuilder } from "discord.js";
import { formatDateSlug } from "../../../util/dateUtils.js";
import { postEventToDiscord, getScheduledDailyDate } from "../index.js";
import { getDb } from "../db.js";
import { estToday, parseDay, prettyDate, respondWithDays } from "../dayInput.js";

export default {
    data: new SlashCommandBuilder()
        .setName("post-daily")
        .setDescription("Post the daily events.")
        .addStringOption(opt =>
            opt.setName("date")
                .setDescription("Which day's events to post, e.g. 10/20 — default: the day the schedule posts next")
                .setAutocomplete(true))
        .addBooleanOption(opt =>
            opt.setName("debug")
                .setDescription("Post to the test channel instead of the live channel")),
    cooldown: 3,

    async autocomplete(interaction) {
        await respondWithDays(interaction);
    },

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const debug = interaction.options.getBoolean("debug") ?? false;
        const input = interaction.options.getString("date");

        let date;
        if (input) {
            date = parseDay(input, estToday());
            if (!date) {
                await interaction.editReply("❌ Couldn't read that date — try `10/20`, `Oct 20` or `2026-10-20`.");
                return;
            }
        } else {
            // A db that can't be read only costs the configured window start; the default
            // (7:30pm) is what it almost always is anyway.
            date = getScheduledDailyDate(await getDb(interaction.client).catch(() => null));
        }
        const day = prettyDate(date);

        try {
            const result = await postEventToDiscord(interaction.client, formatDateSlug(date), { debug });
            const replies = {
                "posted": debug
                    ? `✅ Posted the events for **${day}** to the test channel.`
                    : `✅ Posted the events for **${day}**.`,
                "already-posted": `ℹ️ The events for **${day}** are already posted, so nothing was sent. Use \`debug\` to send a test copy.`,
                "unavailable": `⚠️ The wiki has no Today's Events page for **${day}** — either it isn't up yet, or it's too old to still be listed.`,
                "failed": `❌ Couldn't post the events for **${day}**. \`/dump-logs\` has the details.`,
            };
            await interaction.editReply(replies[result] ?? replies.failed);
        } catch (err) {
            console.error("💥 Post daily command failed:", err);
            await interaction.editReply("❌ Failed to run post daily events.");
        }
    },
};

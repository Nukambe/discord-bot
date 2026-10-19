import { SlashCommandBuilder } from "discord.js";
import { formatDateSlug, toEstDateString } from "../../../util/dateUtils.js";
import { postEventToDiscord, getScheduledDailyDate } from "../index.js";
import { getDb } from "../db.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Days offered in the date picker, relative to today (ET). */
const SUGGESTED_DAYS = [
    { offset: -1, label: "Yesterday" },
    { offset: 0, label: "Today" },
    { offset: 1, label: "Tomorrow" },
    { offset: 2, label: "In 2 days" },
];

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
        const typed = interaction.options.getFocused().trim();
        const today = estToday();
        const suggestions = SUGGESTED_DAYS.map(({ offset, label }) => {
            const date = addDays(today, offset);
            return { name: `${label} — ${prettyDate(date)}`, value: isoDate(date) };
        });

        // A typed date that parses goes first, so "10/25" can be picked as-is.
        const parsed = typed ? parseDay(typed, today) : null;
        const choices = parsed
            ? [{ name: prettyDate(parsed), value: isoDate(parsed) }, ...suggestions.filter(s => s.value !== isoDate(parsed))]
            : suggestions.filter(s => !typed || s.name.toLowerCase().includes(typed.toLowerCase()));
        await interaction.respond(choices.slice(0, 25));
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

/** Today's ET calendar date as a local-midnight Date (the form formatDateSlug reads). */
function estToday() {
    const [y, m, d] = toEstDateString(new Date()).split("-").map(Number);
    return new Date(y, m - 1, d);
}

function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function isoDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * e.g. "Monday, October 19, 2026". Built by hand rather than with toLocaleDateString, which
 * the packaged build's Node runtime has been seen to format differently (see dateUtils.js).
 */
function prettyDate(date) {
    return `${WEEKDAYS[date.getDay()]}, ${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/**
 * Read a typed day: "today" / "tomorrow" / "yesterday", "2026-10-20" (what the picker sends),
 * "10/20" or "10/20/2026", "Oct 20" or "October 20, 2026". A date without a year lands in
 * whichever year puts it nearest today, so "1/2" typed in late December means next month.
 * @param {string} input
 * @param {Date} today - local-midnight Date for today (ET)
 * @returns {Date|null} local-midnight Date, or null when it isn't a real date.
 */
function parseDay(input, today) {
    const s = input.trim().toLowerCase();
    const relative = { yesterday: -1, today: 0, tomorrow: 1 }[s];
    if (relative !== undefined) return addDays(today, relative);

    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return realDate(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/))) return withYear(+m[1], +m[2], m[3], today);
    if ((m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/))) {
        const month = MONTHS.indexOf(m[1]) + 1;
        return month ? withYear(month, +m[2], m[3], today) : null;
    }
    return null;
}

function withYear(month, day, yearText, today) {
    if (yearText) return realDate(yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText), month, day);
    const candidates = [-1, 0, 1]
        .map(offset => realDate(today.getFullYear() + offset, month, day))
        .filter(Boolean);
    candidates.sort((a, b) => Math.abs(a - today) - Math.abs(b - today));
    return candidates[0] ?? null;
}

/** The Date for y-m-d, or null when it rolls over (Feb 30, month 13, ...). */
function realDate(year, month, day) {
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

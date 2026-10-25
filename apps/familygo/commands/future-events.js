import { SlashCommandBuilder } from "discord.js";
import { postFutureEventsToDiscord } from "../postFutureEvents.js";
import { estToday, isoDate, parseDay, prettyDate, respondWithDays } from "../dayInput.js";

/** News is only ever looked up for days that have happened, so the picker offers past days. */
const SUGGESTED_DAYS = [
  { offset: 0, label: "Today" },
  { offset: -1, label: "Yesterday" },
  { offset: -2, label: "2 days ago" },
  { offset: -3, label: "3 days ago" },
];

export default {
  data: new SlashCommandBuilder()
    .setName("future-events")
    .setDescription("Post any Monopoly GO Wiki news since the last Today's Events post that isn't posted yet.")
    .addStringOption((opt) =>
      opt
        .setName("date")
        .setDescription("Only post the news published on this day, e.g. 10/20 — default: everything since the last run")
        .setAutocomplete(true)
    )
    .addBooleanOption((opt) =>
      opt.setName("debug").setDescription("Post to the test channel instead of the live channel")
    ),
  cooldown: 3,

  async autocomplete(interaction) {
    await respondWithDays(interaction, SUGGESTED_DAYS);
  },

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const debug = interaction.options.getBoolean("debug") ?? false;
    const input = interaction.options.getString("date");

    let date = null;
    if (input) {
      date = parseDay(input, estToday());
      if (!date) {
        await interaction.editReply("❌ Couldn't read that date — try `10/20`, `Oct 20` or `2026-10-20`.");
        return;
      }
    }

    try {
      const result = await postFutureEventsToDiscord(interaction.client, {
        debug,
        date: date ? isoDate(date) : null,
      });
      if (date) {
        await interaction.editReply(datedReply(result, prettyDate(date), debug));
      } else {
        await interaction.editReply(
          debug
            ? "✅ Future events executed in debug mode — posted to the test channel."
            : "✅ Future events executed successfully."
        );
      }
    } catch (err) {
      console.error("💥 Future events command failed:", err);
      await interaction.editReply("❌ Failed to run future events.");
    }
  },
};

/**
 * The reply for a `date:` run, from postFutureEventsToDiscord's result.
 * @param {{ posted: number, alreadyPosted: number, failed: number, coversDate: boolean }|null} result
 * @param {string} day - e.g. "Monday, October 19, 2026"
 * @param {boolean} debug
 */
function datedReply(result, day, debug) {
  if (!result) return "❌ Couldn't read the wiki's news page. `/dump-logs` has the details.";

  const { posted, alreadyPosted, failed, coversDate } = result;
  const articles = (n) => `${n} article${n === 1 ? "" : "s"}`;
  const lines = [];
  if (posted) lines.push(`✅ Posted ${articles(posted)} from **${day}**${debug ? " to the test channel" : ""}.`);
  if (alreadyPosted) lines.push(`ℹ️ ${articles(alreadyPosted)} from **${day}** ${alreadyPosted === 1 ? "was" : "were"} already posted.`);
  if (failed) lines.push(`❌ ${articles(failed)} couldn't be fetched or posted. \`/dump-logs\` has the details.`);
  if (!coversDate) {
    lines.push(`⚠️ The wiki's news page doesn't reach back past **${day}**, so older posts from that day may be missing.`);
  } else if (!lines.length) {
    lines.push(`ℹ️ The wiki has no news articles from **${day}**.`);
  }
  return lines.join("\n");
}

import { SlashCommandBuilder } from "discord.js";
import { formatDateSlug } from "../../../util/dateUtils.js";
import { postEventToDiscord } from "../index.js";

export default {
    data: new SlashCommandBuilder()
        .setName("post-daily")
        .setDescription("Post the daily events.")
        .addBooleanOption(opt =>
            opt.setName("debug")
                .setDescription("Post to the test channel instead of the live channel")),
    cooldown: 3,
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const debug = interaction.options.getBoolean("debug") ?? false;

        try {
            const today = new Date();
            const dateSlug = formatDateSlug(today);
            await postEventToDiscord(interaction.client, dateSlug, { debug });
            await interaction.editReply(
                debug
                    ? "✅ Post daily events executed in debug mode — posted to the test channel."
                    : "✅ Post daily events executed successfully."
            );
        } catch (err) {
            console.error("💥 Post daily command failed:", err);
            await interaction.editReply("❌ Failed to run post daily events.");
        }
    },
};

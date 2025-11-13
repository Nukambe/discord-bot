import { SlashCommandBuilder } from "discord.js";
import { getTomorrowSlug } from "../../../util/dateUtils.js";
import { postEventToDiscord } from "../index.js";

export default {
    data: new SlashCommandBuilder()
        .setName("post-daily")
        .setDescription("Post the daily events."),
    cooldown: 3,
    async execute(interaction) {
        const dateSlug = getTomorrowSlug();
        await postEventToDiscord(interaction.client, dateSlug);
    },
};

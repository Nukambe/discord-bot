import { SlashCommandBuilder } from "discord.js";
import { formatDateSlug } from "../../../util/dateUtils.js";
import { postEventToDiscord } from "../index.js";

export default {
    data: new SlashCommandBuilder()
        .setName("post-daily")
        .setDescription("Post the daily events."),
    cooldown: 3,
    async execute(interaction) {
        const dateSlug = formatDateSlug(new Date());
        await postEventToDiscord(interaction.client, dateSlug);
    },
};

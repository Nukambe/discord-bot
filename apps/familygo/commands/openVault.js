import { SlashCommandBuilder } from "discord.js";

export default {
    data: new SlashCommandBuilder()
        .setName("open-vault")
        .setDescription("Decide if you should open your vault during sticker boom."),
    cooldown: 3,

    async execute(interaction) {
        // Positive decisions
        const yesResponses = [
            "✅ Baldy is feeling generous at the moment. Go for it!",
            "✅ Baldy just whispered the odds in your favor. Crack that vault open!",
            "✨ The stars aligned and Baldy nodded approvingly. It’s vault time!",
            "👍 Baldy ran the simulations. Results say: SEND IT.",
            "🎉 Fortune favors the bold — Baldy says go for it!",
            "💎 Baldy is smiling… which is rare. Take the win.",
            "🔥 The vault is practically begging to be opened. Do it!",
            "🍀 Baldy rolled the dice and they came up green. Open it!",
            "🚀 Baldy thinks you’re about to hit something spicy. Open up!",
        ];

        // Negative or cautious decisions
        const noResponses = [
            "🚫 Baldy is feeling mischievous and will play in your face. Don't do it!",
            "🚫 Baldy checked the vibes. They’re awful. Step away from the vault.",
            "⚠️ Baldy just shook his head slowly. That’s a no.",
            "❌ Baldy sees a future full of pain. Don’t do it.",
            "👀 Baldy is side-eyeing you HARD. That's a vault-shut moment.",
            "💀 If you open it now, Baldy will personally laugh at you. Don’t.",
            "🛑 Baldy threw a red flag on the play. No vault today.",
            "😬 Baldy winced. That should tell you everything.",
            "🙅 Baldy’s gut says no — and his gut is never wrong.",
        ];

        // Weighted random choice
        const isYes = Math.random() < 0.5;

        const decisions = isYes ? yesResponses : noResponses;
        const decision = decisions[Math.floor(Math.random() * decisions.length)];

        let reply = `🎰 **Monopoly GO Vault Oracle**\n\n${decision}`;

        await interaction.reply(reply);
    },
};

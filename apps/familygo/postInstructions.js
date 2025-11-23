import { Collection, EmbedBuilder, Events } from "discord.js";

const FORTUNE_FLIP_CHANNEL_ID = process.env.FORTUNE_FLIP_CHANNEL_ID;
const FORTUNE_FLIP_INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes

let fortuneFlipTimeout = null;

// Commands that should NOT be shown in the instructions
const excludeCommands = ["gift-rotation", "post-daily"];

function scheduleFortuneFlipInstructions(client) {
  if (fortuneFlipTimeout) {
    clearTimeout(fortuneFlipTimeout);
  }

  fortuneFlipTimeout = setTimeout(async () => {
    try {
      await postInstrctions(client);
    } catch (err) {
      console.error("Error posting Fortune Flip instructions:", err);
    }
  }, FORTUNE_FLIP_INACTIVITY_MS);
}

export function fortuneFlipChannelListener(client) {
  if (!FORTUNE_FLIP_CHANNEL_ID) {
    console.warn("FORTUNE_FLIP_CHANNEL_ID is not set; listener will not be attached.");
    return;
  }

  if (!client.commands) {
    client.commands = new Collection();
  }

  const handleActivity = (channelId) => {
    if (channelId !== FORTUNE_FLIP_CHANNEL_ID) return;
    scheduleFortuneFlipInstructions(client);
  };

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    handleActivity(message.channelId);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    handleActivity(interaction.channelId);
  });

  scheduleFortuneFlipInstructions(client);
}

export async function postInstrctions(client) {
  if (!FORTUNE_FLIP_CHANNEL_ID) return;

  const channel = await client.channels.fetch(FORTUNE_FLIP_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    console.warn("Fortune Flip channel is not text-based or could not be fetched.");
    return;
  }

  // Build command list, filtering out excluded commands
  const commandLines = [];

  for (const cmd of client.commands.values()) {
    if (!cmd.data) continue;

    const name = cmd.data.name;

    if (excludeCommands.includes(name)) continue; // <-- filter here

    const description = cmd.data.description ?? "No description provided.";
    commandLines.push(`• \`/${name}\` – ${description}`);
  }

  const description = [
    "Reminder: You can use the bot commands in this channel to manage rotations and other features.",
    "",
    "Once you run a command, there is a short cooldown before you can run it again. Please wait for the cooldown to end before trying again.",
    "",
    "**To use a command you can type:**",
    "• `/<command>` and select it from the menu",
    "",
    "**Available commands:**",
    ...(commandLines.length ? commandLines : ["• *(No commands registered on this bot instance.)*"]),
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(0xF5A623)
    .setTitle("<:fortuneFlip:1441956260797747261> Bot Command Guide")
    .setDescription(description);

  await channel.send({ embeds: [embed] });
}

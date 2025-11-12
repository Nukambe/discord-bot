import { REST, Routes } from "discord.js";
import { loadCommands } from "../../util/loadCommands.js";
import path from "node:path";
import "dotenv/config";

export async function deployCommands() {
  const commandsPath = path.resolve("apps/familygo/commands");
  const { commands, jsonForDeploy } = await loadCommands(commandsPath);
  console.log(`🧩 Loaded ${commands.size} commands`);

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log("📌 Registering GUILD commands (fast updates)...");
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: jsonForDeploy }
      );
      console.log("✅ Guild commands registered");
  } catch (err) {
    console.error("💥 Command registration failed:", err);
  }
}

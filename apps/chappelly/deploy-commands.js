import { REST, Routes } from "discord.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCommands } from "../../util/loadCommands.js";
import "dotenv/config";

export const COMMANDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "commands");

/**
 * Register chappelly's guild commands. Unlike the other apps this runs after
 * the client is ready rather than at import time: the guild is whichever
 * server holds the env channel and the application id is the logged-in
 * user's, so neither needs its own env var.
 */
export async function deployCommands({ applicationId, guildId }) {
  const { commands, jsonForDeploy } = await loadCommands(COMMANDS_DIR);
  console.log(`🧩 [chappelly] Loaded ${commands.size} commands`);

  const rest = new REST({ version: "10" }).setToken(process.env.CHAPPELLY_TOKEN);

  try {
    console.log("📌 [chappelly] Registering GUILD commands (fast updates)...");
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: jsonForDeploy });
    console.log("✅ [chappelly] Guild commands registered");
  } catch (err) {
    console.error("💥 [chappelly] Command registration failed:", err);
  }
}

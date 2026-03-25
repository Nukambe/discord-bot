import { REST, Routes } from "discord.js";
import { loadCommands } from "../../util/loadCommands.js";
import path from "node:path";
import "dotenv/config";

export async function deployCommands() {
  const commandsPath = path.resolve("apps/nukoko/commands");
  const { commands, jsonForDeploy } = await loadCommands(commandsPath);
  console.log(`🧩 Loaded ${commands.size} commands`);

  const rest = new REST({ version: "10" }).setToken(process.env.NUKOKO_TOKEN);

  try {
    console.log("📌 Registering GUILD commands (fast updates)...");
    await rest.put(
      Routes.applicationGuildCommands(process.env.NUKOKO_CLIENT_ID, "1457444291801776273"),
      { body: jsonForDeploy }
    );
    console.log("✅ Guild commands registered");
  } catch (err) {
    console.error("💥 Command registration failed:", err);
  }
}

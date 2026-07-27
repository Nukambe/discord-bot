import { REST, Routes } from "discord.js";
import { loadCommands, loadCommandsFromModules } from "../../util/loadCommands.js";
import { staticCommands } from "./commands/index.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import "dotenv/config";

export async function deployCommands() {
  // Packaged (pkg) builds can't dynamic-import into the snapshot, so they use
  // the static command list instead of scanning the commands/ directory.
  // (import.meta.url is unavailable in a bundled CJS build, so it's only
  // evaluated on the non-packaged branch.)
  const { commands, jsonForDeploy } = process.pkg
    ? loadCommandsFromModules(staticCommands)
    : await loadCommands(path.join(path.dirname(fileURLToPath(import.meta.url)), "commands"));
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

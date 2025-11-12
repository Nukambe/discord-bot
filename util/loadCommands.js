import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

export async function loadCommands(commandsDir) {
  const commands = new Map();
  const jsonForDeploy = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        modules.push(full);
      }
    }
  };

  const modules = [];
  walk(commandsDir);

  for (const file of modules) {
    const mod = (await import(pathToFileURL(file))).default;
    if (!mod?.data?.name || typeof mod.execute !== "function") {
      console.warn(`⚠️ Skipping ${file} (missing data.name or execute)`);
      continue;
    }
    // attach optional metadata:
    if (typeof mod.dmPermission === "boolean") mod.data.setDMPermission(mod.dmPermission);
    if (mod.defaultMemberPermissions != null) mod.data.setDefaultMemberPermissions(mod.defaultMemberPermissions);

    commands.set(mod.data.name, mod);
    jsonForDeploy.push(mod.data.toJSON());
  }

  return { commands, jsonForDeploy };
}

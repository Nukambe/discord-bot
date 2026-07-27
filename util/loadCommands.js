import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

function buildRegistry(mods) {
  const commands = new Map();
  const jsonForDeploy = [];

  for (const mod of mods) {
    if (!mod?.data?.name || typeof mod.execute !== "function") {
      console.warn(`⚠️ Skipping a command module (missing data.name or execute)`);
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

export async function loadCommands(commandsDir) {
  const modules = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        modules.push(full);
      }
    }
  };
  walk(commandsDir);

  const mods = await Promise.all(modules.map((file) => import(pathToFileURL(file)).then((m) => m.default)));
  return buildRegistry(mods);
}

/**
 * Same normalization as loadCommands(), but from an already-imported list of
 * command modules instead of a runtime directory scan. Needed for bundled/
 * packaged builds where dynamic import() can't reach the bundler's snapshot.
 */
export function loadCommandsFromModules(mods) {
  return buildRegistry(mods);
}

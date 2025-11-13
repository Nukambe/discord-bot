import { readdir } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

/**
 * Loads all commands from ../commands/*.js
 * Each command file must `export default` an object:
 * { name, aliases?, desc, usage?, cooldownMs?, modOnly?, exec(ctx) }
 * Returns Map<nameOrAlias, def>
 */
export async function loadCommands() {
  const commandsDirUrl = new URL('../commands/', import.meta.url);
  const commandsDir = fileURLToPath(commandsDirUrl);
  const files = (await readdir(commandsDir)).filter(f => f.endsWith('.js'));

  const registry = new Map();
  const primaryByRef = new Map(); // for help to dedupe aliases

  for (const file of files) {
    const full = path.join(commandsDir, file);
    const mod = await import(pathToFileURL(full).href);
    const def = mod.default;
    validate(def, file);

    // register primary
    registry.set(def.name, def);
    if (!primaryByRef.has(def)) primaryByRef.set(def, def.name);

    // register aliases
    if (Array.isArray(def.aliases)) {
      for (const alias of def.aliases) {
        registry.set(alias, def);
      }
    }
  }

  // attach a helper to list unique primary names (for help command)
  registry.listPrimaryNames = () => {
    return [...primaryByRef.values()].sort();
  };

  return registry;
}

function validate(def, file) {
  if (!def || typeof def !== 'object') throw new Error(`Command ${file} must export default object`);
  if (!def.name || typeof def.name !== 'string') throw new Error(`Command ${file} missing "name"`);
  if (def.aliases && !Array.isArray(def.aliases)) throw new Error(`Command ${file} "aliases" must be array`);
  if (typeof def.exec !== 'function') throw new Error(`Command ${file} missing "exec(ctx)"`);
  // defaults
  if (!def.cooldownMs) def.cooldownMs = 3000;
  if (!('modOnly' in def)) def.modOnly = false;
  if (!def.desc) def.desc = '(no description)';
}

import { COMMAND_PREFIX } from '../lib/utils.js';

export default {
  name: 'help',
  desc: 'List commands or show details.',
  usage: '!help [command]',
  async exec({ channel, args, registry, client }) {
    if (!args.length) {
      const names = registry.listPrimaryNames();
      await client.say(channel, `Commands: ${names.map(n => COMMAND_PREFIX + n).join(', ')}`);
      return;
    }
    const q = args[0].toLowerCase();
    const def = registry.get(q);
    if (!def) {
      await client.say(channel, `No command named "${q}".`);
      return;
    }
    await client.say(
      channel,
      `${COMMAND_PREFIX}${def.name} — ${def.desc}${def.usage ? ` | Usage: ${def.usage}` : ''}${def.modOnly ? ' | (mods only)' : ''}`
    );
  },
};

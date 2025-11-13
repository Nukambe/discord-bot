export const COMMAND_PREFIX = '!';

export function parseCommand(message) {
  if (!message.startsWith(COMMAND_PREFIX)) return null;
  const without = message.slice(COMMAND_PREFIX.length).trim();
  const [name, ...rest] = without.split(/\s+/);
  return { name: name.toLowerCase(), args: rest, rawArgs: rest.join(' ') };
}

export function isModOrBroadcaster(tags) {
  return tags.mod || tags.badges?.broadcaster === '1';
}

export async function safeSay(client, channel, text) {
  try {
    await client.say(channel, text);
  } catch (err) {
    console.error('send failed:', err?.message || err);
  }
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}

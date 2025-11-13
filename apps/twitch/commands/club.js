export default {
  name: 'club',
  aliases: ['crew'],
  desc: 'What club is Nukambe in?',
  usage: '!club',
  cooldownMs: 3000,
  modOnly: false,
  async exec({ channel, args, rawArgs, tags, client, registry }) {
    await client.say(channel, 'Rephrase');
  },
};
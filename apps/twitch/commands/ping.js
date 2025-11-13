export default {
  name: 'ping',
  desc: 'Check bot responsiveness.',
  async exec({ channel, client }) {
    const t0 = Date.now();
    await client.say(channel, 'pong!');
    const rtt = Date.now() - t0;
    console.log(`ping RTT ~${rtt}ms`);
  },
};

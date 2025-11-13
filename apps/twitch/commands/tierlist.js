// Hardcoded tier list command
// Example: !tierlist or !tiers

export default {
  name: 'tierlist',
  aliases: ['tiers'],
  desc: 'Show my DCD tierlist.',
  cooldownMs: 4000,

  async exec({ channel, client }) {
    const tierList = {
      S: ['Wade'],
      A: ['Rodman', 'Westbrook', 'James Jonah Jameson', 'SGA', 'Tatum', 'Olajuwon', 'Kidd', 'Murray', 'George', 'Lopez', 'Durant', 'Embiid', 'Leonard', 'Davis', 'Gasol'],
      B: ['James', 'Giannis', 'Jokic', 'Curry', 'Paul', 'Doncic', 'Zion', 'Booker', 'McCollum*', 'Clarkson', 'Nowitzky', 'Wiggins', 'DeRozan*'],
      C: ['Lavine', 'Thompson', 'Capela', 'Anderson*', 'Fu Zhi', 'Julio', 'Ingram*', 'Porzingis', 'Adebayo*'],
      D: ['Shining Players...'],
    };

    for (const [tier, items] of Object.entries(tierList)) {
      await client.say(channel, `${tier} — ${items.join(', ')}`);
    }
    await client.say(channel, "Characters with an '*': I don't know enough about.");

    // Twitch has a 500-char limit per message → chunk just in case
    // const chunks = chunkMessages(lines, 450);

    // for (const msg of chunks) {
    //   await client.say(channel, msg);
    // }
  },
};

// --- helper ---
function chunkMessages(lines, maxLen) {
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const add = cur.length ? ` | ${line}` : line;
    if ((cur + add).length > maxLen) {
      if (cur) chunks.push(cur);
      cur = line;
    } else {
      cur += add;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

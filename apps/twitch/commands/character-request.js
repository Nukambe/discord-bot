const CHARACTERS = {
  PG: ['Yukio Kasamatsu', 'Kazunari Takao', 'Shoichi Imayoshi', 'Koki Furihata', 'Seijuro Akashi', 'Shun Izuki'],
  SG: ['Junpei Hyuga', 'Ryo Sakurai', 'Yoshitaka Moriyama', 'Tatsuya Himuro', 'Reo Mibuchi', 'Shintaro Midorima', 'Diviner Midorima'],
  SF: ['Shinji Koganei', 'Ryota Kise', 'Liu Wei'],
  PF: ['Taiga Kagami', 'LAST GAME Kagami', 'Mitsuhiro Hayakawa', 'Satoshi Tsuchida', 'Daiki Aomine', 'Chihiro Mayuzumi'],
  C: ['Rinnosuke Mitobe', 'Taisuke Otsubo', 'Atsushi Murasakibara', 'Kosuke Wakamatsu', 'Koji Kobori', 'Teppei Kiyoshi'],
  // Kuroko's in-game position tag is "?" (Phantom Sixth Man, doesn't fit the standard 5 positions)
  '?': ['Tetsuya Kuroko', 'Miracle Tetsuya'],
};

const POSITIONS = {
  PG: 'Point Guard',
  SG: 'Shooting Guard',
  SF: 'Small Forward',
  PF: 'Power Forward',
  C: 'Center',
  '?': 'Special',
};

const ALL_NAMES = Object.values(CHARACTERS).flat();

const NAMES_BY_LOWER = new Map(
  ALL_NAMES.map(name => [name.toLowerCase(), name])
);

// Also allow matching by last name alone (e.g. "kuroko" for "Tetsuya
// Kuroko"), since chat requests are unlikely to type full names. Only kept
// when unambiguous across the whole roster.
const NAMES_BY_LAST = new Map();
for (const name of ALL_NAMES) {
  const last = name.split(' ').pop().toLowerCase();
  NAMES_BY_LAST.set(last, NAMES_BY_LAST.has(last) ? null : name);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Queue backing the overlay's "Character Request Queue" panel. Module-level
// so it persists across calls (the command module is only loaded once).
// The overlay owns fulfillment client-side (see App.jsx) — the bot just
// appends and re-broadcasts the full list.
const QUEUE_LIMIT = 25;
let queue = [];

export default {
  name: 'character-request',
  aliases: ['crequest', 'cr'],
  desc: 'Request a character by name, position (pg/sg/sf/pf/c/?), or "random". Usage: !character-request <name|position|random>',
  usage: '!character-request <name|position|random>',
  cooldownMs: 5000,

  async exec({ channel, args, tags, client, overlay }) {
    if (!args.length) {
      await client.say(channel, `Usage: ${this.usage}`);
      return;
    }

    const query = args.join(' ').trim();
    const requester = tags['display-name'] || tags.username;
    const lower = query.toLowerCase();
    const upper = query.toUpperCase();

    let character;

    if (lower === 'random') {
      character = pickRandom(ALL_NAMES);
    } else if (POSITIONS[upper]) {
      character = pickRandom(CHARACTERS[upper]);
    } else if (NAMES_BY_LOWER.has(lower)) {
      character = NAMES_BY_LOWER.get(lower);
    } else if (NAMES_BY_LAST.get(lower)) {
      character = NAMES_BY_LAST.get(lower);
    } else {
      await client.say(
        channel,
        `@${requester} "${query}" isn't a valid character or position (pg/sg/sf/pf/c/?). Try !help character-request.`
      );
      return;
    }

    queue = [
      ...queue,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, requester, character, at: Date.now() },
    ].slice(-QUEUE_LIMIT);
    overlay?.push('character-queue', queue);

    await client.say(channel, `@${requester} requested: ${character}!`);
  },
};

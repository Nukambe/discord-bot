// Character roster for the nukoko bot. Copied from
// apps/twitch/commands/character-request.js — the two bots are independent, so
// the roster is intentionally duplicated across apps, but shared within nukoko.
export const CHARACTERS = {
  PG: ["Yukio Kasamatsu", "Kazunari Takao", "Shoichi Imayoshi", "Koki Furihata", "Seijuro Akashi", "Shun Izuki", "Nash Gold Jr.", "SP Seijuro Akashi", "Makoto Hanamiya"],
  SG: ["Junpei Hyuga", "Ryo Sakurai", "Yoshitaka Moriyama", "Tatsuya Himuro", "Reo Mibuchi", "Shintaro Midorima", "Diviner Midorima"],
  SF: ["Shinji Koganei", "Ryota Kise", "Liu Wei", "Perfect Copy Kise", "Haizaki Shogo", "Kotaro Hayama"],
  PF: ["Taiga Kagami", "LAST GAME Kagami", "Mitsuhiro Hayakawa", "Satoshi Tsuchida", "Daiki Aomine", "ZONE Daiki Aomine", "Chihiro Mayuzumi", "ZONE Taiga Kagami"],
  C: ["Rinnosuke Mitobe", "Taisuke Otsubo", "Atsushi Murasakibara", "Kosuke Wakamatsu", "Koji Kobori", "Teppei Kiyoshi", "Jason Silver", "ZONE Atsushi Murasakibara"],
  // Kuroko's in-game position tag is "?" (Phantom Sixth Man, doesn't fit the standard 5 positions)
  "?": ["Tetsuya Kuroko", "Miracle Tetsuya"],
};

export const POSITIONS = {
  PG: "Point Guard",
  SG: "Shooting Guard",
  SF: "Small Forward",
  PF: "Power Forward",
  C: "Center",
  "?": "Special",
};

export const POSITION_OF = new Map(
  Object.entries(CHARACTERS).flatMap(([pos, names]) => names.map((name) => [name, pos]))
);

export const ALL_NAMES = Object.values(CHARACTERS).flat();

/**
 * Resolve loose user input to the canonical roster spelling.
 * @param {string} input
 * @returns {string|null} the canonical name, or null if it isn't on the roster
 */
export function resolveCharacter(input) {
  if (!input) return null;
  const needle = input.trim().toLowerCase();
  return ALL_NAMES.find((name) => name.toLowerCase() === needle) ?? null;
}

/**
 * Roster names matching a partial query, prefix matches first.
 * The roster is larger than the 25-choice cap on a slash command option, so
 * every character option uses autocomplete backed by this instead of choices.
 * @param {string} query
 * @param {number} limit
 * @returns {string[]}
 */
export function searchCharacters(query, limit = 25) {
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return ALL_NAMES.slice(0, limit);

  const starts = [];
  const contains = [];
  for (const name of ALL_NAMES) {
    const lower = name.toLowerCase();
    if (lower.startsWith(needle)) starts.push(name);
    else if (lower.includes(needle)) contains.push(name);
  }
  return [...starts, ...contains].slice(0, limit);
}

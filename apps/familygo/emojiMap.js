/**
 * Custom server emojis for known Monopoly GO events, matched by name.
 *
 * Shared by the daily schedule post (formatEvent.js) and the weekly predictions
 * post (postWeeklyPredictions.js) — keep every event-name → emoji rule here so
 * the two posts can't drift apart.
 *
 * Order matters: pickEmoji takes the first match, not the most specific one, so
 * narrower patterns (e.g. the dig-minigame family) must sit above broader ones.
 */
export const EMOJI_MAP = [
  { re: /\bboard\s*rush\b/i, emoji: "<:BoardRush:1437570220813320221>" },
  { re: /\bbuilder'?s?\s*bash\b/i, emoji: "<:BuildersBash:1437570222008832221>" },
  { re: /\bcash\s*boost\b/i, emoji: "<:CashBoost:1437570223816441976>" },
  { re: /\bcash\s*grab\b/i, emoji: "<:CashGrab:1437570224927801488>" },
  { re: /\bgolden\s*blitz\b/i, emoji: "<:GoldenBlitz:1437570226966495373>" },
  // Dig-minigame family. The daily schedule names this event "Dig Treasures" (the wiki's
  // preview posts call it "Roll Treasures") — neither matched the older Dig_Tool patterns
  // below, so it fell through to the "•" fallback bullet. Must stay above the Dig_Tool
  // entry: pickEmoji takes the first match, not the most specific one.
  { re: /\bdig\s*minigame\b|\b(?:dig|roll)\s*treasures?\b|\btreasure\s*dig\b/i, emoji: "<:dig_pickaxe:1538289771686928465>" },
  { re: /\bdig(ging)?\s*tool|\btreasure\s*hunt|\bpickaxe/i, emoji: "<:Dig_Tool:1437570228421791855>" },
  { re: /\bhigh\s*roller\b/i, emoji: "<:HighRoller:1437570229390545008>" },
  { re: /\btoken|\bchip\b/i, emoji: "<:Icon_Chip_Small:1437570231131312278>" },
  { re: /\bjackpot\s*stash\b.*free\s*parking\b/i, emoji: "<:JackpotStash_FreeParking_Minigam:1437570232393793726>" },
  { re: /\bfree\s*parking\b.*\[cash\]/i, emoji: "<:JackpotStash_FreeParking_Money:1437570780635332812>" },
  { re: /\bfree\s*parking\b.*\[dice\]/i, emoji: "<:JackpotStash_FreeParking_Rolls:1437570235866808330>" },
  { re: /\bfree\s*parking\b/i, emoji: "<:JackpotStash_FreeParking_Minigam:1437570232393793726>" },
  { re: /\bwheel\s*boost\b/i, emoji: "<:WheelBoost:1437570786947891393>" },
  { re: /\bsticker\s*boom\b/i, emoji: "<:StickerBoom:1437570250274242785>" },
  { re: /\bno\s*vacancy\b/i, emoji: "<:NoVacancy:1437570246549700759>" },
  { re: /\brent\s*frenzy\b/i, emoji: "<:NoVacancy:1437570246549700759>" },
  { re: /\bmega\s*heist|\bmega\s*bank\s*heist\b/i, emoji: "<:MegaBankHeist:1437570785685274845>" },
  { re: /\blucky\s*roll\b/i, emoji: "<:LuckyRoll:1437570243768881244>" },
  { re: /\broll\s*match\b/i, emoji: "<:LuckyRoll:1437570243768881244>" },
  { re: /\blucky\s*chance\b/i, emoji: "<:LuckyChance:1437570240019173516>" },
  { re: /\blandmark\s*rush\b/i, emoji: "<:LandmarkRush:1437570782925684908>" },
  { re: /\bbattleship\b/i, emoji: "<:carnival_games:1537956721065197618>" },
  { re: /\btycoon\s*class\b/i, emoji: "<:tycoon_class:1533835656315539637>" },
  { re: /\bcarnivalgames\b/i, emoji: "<:carnival_games:1537956721065197618>" },
  { re: /\btycoon\s*racers\b/i, emoji: "<:RaceCup_Currency_Icon:1441936191870992454>" },
  { re: /\bfortune\s*teller\b/i, emoji: "<:carnival_games:1537956721065197618>" },
  { re: /\btrade\s*fest\b/i, emoji: "<:TradeFest_PillIcon:1441936194379190422>" },
  { re: /\bprize\s*drop\b/i, emoji: "<:prize_drop:1531717495533076560>" },
  { re: /\bjackpot\s*stash\b/i, emoji: "<:JackpotStash_FreeParking_Minigam:1437570232393793726>" },
  { re: /\badventures?\b/i, emoji: "<:AdventureEvent_Icon_Commodity:1489742463345234091>" },
  { re: /\bpartner\s*event\b/i, emoji: "<:partners:1531685860410527954>" },
  { re: /\bminigame:\s*blocks\b/i, emoji: "<:blocks_boutique:1529168959092424901>" },
  { re: /\bjuggle\s*jam\b/i, emoji: "<:carnival_games:1537956721065197618>" },
];

/**
 * The emoji for an event name, or a plain "•" bullet when nothing matches.
 * @param {string} name
 * @returns {string}
 */
export function pickEmoji(name) {
  const found = EMOJI_MAP.find(({ re }) => re.test(name));
  return found ? found.emoji : "•";
}

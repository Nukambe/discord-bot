/** Custom emojis for known events (used in headings) */
const EMOJI_MAP = [
  { re: /\bboard\s*rush\b/i, emoji: "<:BoardRush:1437570220813320221>" },
  { re: /\bbuilder'?s?\s*bash\b/i, emoji: "<:BuildersBash:1437570222008832221>" },
  { re: /\bcash\s*boost\b/i, emoji: "<:CashBoost:1437570223816441976>" },
  { re: /\bcash\s*grab\b/i, emoji: "<:CashGrab:1437570224927801488>" },
  { re: /\bgolden\s*blitz\b/i, emoji: "<:GoldenBlitz:1437570226966495373>" },
  { re: /\bdig(ging)?\s*tool|\btreasure\s*hunt|\bpickaxe/i, emoji: "<:Dig_Tool:1437570228421791855>" },
  { re: /\bhigh\s*roller\b/i, emoji: "<:HighRoller:1437570229390545008>" },
  { re: /\btoken|\bchip\b/i, emoji: "<:Icon_Chip_Small:1437570231131312278>" },
  { re: /\bjackpot\s*stash\b.*free\s*parking\b.*mini/i, emoji: "<:JackpotStash_FreeParking_Minigam:1437570232393793726>" },
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
  { re: /\bjackpot\s*stash\b.*free\s*parking\b.*roll/i, emoji: "<:JackpotStash_FreeParking_Rolls:1437570235866808330>" },
  { re: /\bjackpot\s*stash\b.*free\s*parking\b.*(cash|money)/i, emoji: "<:JackpotStash_FreeParking_Money:1437570780635332812>" },
  { re: /\bbattleship\b/i, emoji: "<:Battleship_MGW:1437905064260927620>" },
  { re: /\btournament\b/i, emoji: "<:tournament:1437914131180294355>" },
  { re: /\bcarnivalgames\b/i, emoji: "<:carnivalgames:1437914039203270810>" }
];

export function formatMogoDiscordMessage(payload, source) {
  if (!payload?.content) return { content: "", embeds: [] };

  const parsed = splitIntoSections(payload.content);
  const dateText = extractDateFromTitle(parsed.title) || "Today";
  const title = `🎲 Monopoly GO! Events | ${dateText}`;

  // Build sections
  const tournamentsField = buildTournamentsField(parsed.sections["Tournaments"] || [], dateText);
  const flashField = buildFlashEventsField(
    parsed.sections["Special Events"] || parsed.sections["Flash Events"] || [],
    dateText
  );
  const quickWinsField = buildQuickWinsField(parsed.sections["Quick Wins"] || []);

  // Main embed
  const main = {
    title,
    url: payload.embeds?.[0]?.url || null,
    fields: []
  };

  if (tournamentsField) {
    main.fields.push(tournamentsField);
  }

  // spacer
  if (tournamentsField && (flashField || quickWinsField)) {
    main.fields.push({ name: "\u200B", value: "\u200B", inline: false });
  }

  if (flashField) {
    main.fields.push(flashField);
  }

  // spacer
  if (flashField && quickWinsField) {
    main.fields.push({ name: "\u200B", value: "\u200B", inline: false });
  }

  if (quickWinsField) {
    main.fields.push(quickWinsField);
  }

  // Images: first on main embed, others as image-only embeds
  const MAX_IMAGE_EMBEDS = 4;
  const imgs = extractImageUrls(payload.embeds);
  const featuredImage = imgs[0] || null;
  const extraImages = imgs.slice(1);

  if (featuredImage) {
    main.image = { url: featuredImage };
  }

  const imageEmbeds = extraImages
    .slice(0, Math.max(0, MAX_IMAGE_EMBEDS))
    .map(url => ({
      url: payload.embeds?.[0]?.url || null,
      image: { url }
    }));

  return { content: `source: ${source}`, embeds: [main, ...imageEmbeds] };
}

/* ------------------------------------------------------------------ */
/* Section parsing                                                     */
/* ------------------------------------------------------------------ */

function splitIntoSections(plain) {
  const lines = plain.split(/\r?\n/);
  const out = { title: "", sections: {} };
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Title: **Something**
    if (!out.title && /^\*\*.+\*\*$/.test(line)) {
      out.title = line.replace(/^\*\*|\*\*$/g, "");
      continue;
    }

    // Headers: __Tournaments__, __Flash Events__, __Quick Wins__
    const h = line.match(/^__([^_]+)__/);
    if (h) {
      current = h[1].trim();
      if (!out.sections[current]) out.sections[current] = [];
      continue;
    }

    // Bullet lines
    if (current && line.startsWith("•")) {
      out.sections[current].push(line);
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Field builders                                                      */
/* ------------------------------------------------------------------ */

function buildTournamentsField(bullets, pageDateStr) {
  if (!bullets.length) return null;

  const header = "**__Tournaments__**";
  const body = bullets
    .map(b => {
      const { name, start, end, durationHMS } = parseBullet(b, pageDateStr);
      const emoji = pickEmoji("tournament");

      const lines = [
        `${emoji} **${name}**`,
        `- Start: \`${start || "Unknown"}\``,
        `- End: \`${end || "Unknown"}\``
      ];

      if (durationHMS) {
        // Tournament duration is days:hours:minutes
        lines.push(`- Duration: \`${prettyTournamentDuration(durationHMS)}\``);
      }

      return lines.concat("").join("\n");
    })
    .join("\n");

  return {
    name: header,
    value: trimTo(body, 1024),
    inline: false
  };
}

function buildFlashEventsField(bullets, pageDateStr) {
  if (!bullets.length) return null;

  const header = "**__Flash Events__**";
  const body = bullets
    .map(b => {
      const { name, start, end, startTimeOnly, endTimeOnly, durationHMS } = parseBullet(b, pageDateStr);
      const emoji = pickEmoji(name);

      // We assume `start`/`end` are already fully formatted from the parser.
      const startText = start || startTimeOnly || "Unknown";
      const endText = end || endTimeOnly || "Unknown";

      const lines = [
        `${emoji} **${name}**`,
        `- Start: \`${startText}\``,
        `- End: \`${endText}\``
      ];

      if (durationHMS) {
        // Flash/other events duration is hours:minutes:seconds
        lines.push(`- Duration: \`${prettyDuration(durationHMS)}\``);
      }

      return lines.concat("").join("\n");
    })
    .join("\n");

  return {
    name: header,
    value: trimTo(body, 1024),
    inline: false
  };
}

function buildQuickWinsField(bullets) {
  if (!bullets.length) return null;

  const header = "**__Quick Wins__**";
  const body = bullets
    .map(b => {
      const { name, rewards } = parseQuickWin(b);
      const lines = [`**${name}**`];

      if (rewards.length) {
        for (const r of rewards) {
          lines.push(`- ${r}`);
        }
      }

      return lines.concat("").join("\n");
    })
    .join("\n");

  return {
    name: header,
    value: trimTo(body, 1024),
    inline: false
  };
}

/* ------------------------------------------------------------------ */
/* Bullet parsing (dates are already formatted upstream)              */
/* ------------------------------------------------------------------ */

/**
 * Parse a bullet line into structured data.
 * We now trust the date/time strings that come from `parseMonopolyEventPage`,
 * so no more re-formatting here — we just extract them.
 */
function parseBullet(line /*, pageDateStr */) {
  const name = (line.match(/\*\*(.+?)\*\*/) || [, "Event"])[1].trim();

  // Duration is always captured as hh:mm:ss or dd:hh:mm (we treat it as raw)
  const durMatch = line.match(/Duration:\s*([0-9]{1,2}:[0-9]{2}:[0-9]{2})/i);
  const durationHMS = durMatch?.[1] || null;

  const se = line.replace(/^•\s*/, "").split("  •  ")[0];
  const arrowIdx = se.indexOf("→");
  let startRaw = "";
  let endRaw = "";

  if (arrowIdx !== -1) {
    const left = se.slice(0, arrowIdx);
    const right = se.slice(arrowIdx + 1);
    const parts = left.split("—");
    startRaw = (parts[1] || "").trim();
    endRaw = right.trim();
  }

  const start = startRaw || null;
  const end = endRaw || null;

  // Optional "time only" variants (seconds stripped) if you want them
  const startTimeOnly = startRaw ? stripSeconds(startRaw) : "";
  const endTimeOnly = endRaw ? stripSeconds(endRaw) : "";

  return {
    name,
    start,
    end,
    startTimeOnly,
    endTimeOnly,
    durationHMS
  };
}

function parseQuickWin(line) {
  const name = (line.match(/\*\*(.+?)\*\*/) || [, "Task"])[1].trim();

  let rewards = [];
  const after = line.split("  •  ")[1] || "";
  if (after) {
    rewards = after
      .split("|")
      .map(s => s.trim())
      .map(s => s.replace(/\s*x(\d+)/i, " $1"))
      .map(s => s.replace(/\s{2,}/g, " "));
  }

  return { name, rewards };
}

/**
 * Extract the date (inside parentheses) from the title.
 * Example: "Monopoly GO Events (11/16/2025)" -> "11/16/2025"
 */
function extractDateFromTitle(title) {
  const m = title.match(/\(([^)]+)\)/);
  return m?.[1]?.trim() || "";
}

/**
 * Remove seconds from a time/date-time string like:
 * "11/17/2025, 12:00:00 PM" -> "11/17/2025, 12:00 PM"
 * "12:00:00 PM" -> "12:00 PM"
 */
function stripSeconds(t) {
  return t
    .replace(/:00(\s*[AP]M)?$/i, "$1")
    .replace(/:([0-5]\d):[0-5]\d/i, ":$1");
}

/* ------------------------------------------------------------------ */
/* Misc helpers                                                       */
/* ------------------------------------------------------------------ */

function pickEmoji(name) {
  const found = EMOJI_MAP.find(({ re }) => re.test(name));
  return found ? found.emoji : "•";
}

/**
 * Flash/other events duration: hours:minutes:seconds
 */
function prettyDuration(hms) {
  const [h, m, s] = hms.split(":").map(n => parseInt(n, 10));
  const parts = [];
  if (h) parts.push(`${h} Hour${h === 1 ? "" : "s"}`);
  if (m) parts.push(`${m} Minute${m === 1 ? "" : "s"}`);
  if (!h && !m && s) parts.push(`${s} Second${s === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/**
 * Tournament duration: days:hours:minutes
 */
function prettyTournamentDuration(dhm) {
  const [d, h, m] = dhm.split(":").map(n => parseInt(n, 10));
  const parts = [];
  if (d) parts.push(`${d} Day${d === 1 ? "" : "s"}`);
  if (h) parts.push(`${h} Hour${h === 1 ? "" : "s"}`);
  if (m) parts.push(`${m} Minute${m === 1 ? "" : "s"}`);
  return parts.join(" ");
}

function trimTo(str, n) {
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

function extractImageUrls(embeds) {
  const urls = [];

  for (const e of embeds || []) {
    const u = e?.image?.url || e?.thumbnail?.url;
    if (u) urls.push(u);
  }

  // Dedupe, keep order
  return Array.from(new Set(urls));
}

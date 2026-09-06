import { pickEmoji, pickQuickWinEmoji } from "./emojiMap.js";

// The wiki lists these under Tournaments, but they're the always-running backbone
// entries (the week-long "Week Of" milestone and the Piggy Bank), not something the
// day's schedule is planned around — dropped from the post, in every section.
const EXCLUDED_EVENTS = /\bweek\s*of\b|\bpiggy\s*bank\b/i;

/**
 * Turn the parsed "Today's Events" payload into the daily Discord post:
 *
 *   source: <https://monopolygo.wiki/todays-events-sep-06-2026>   ← message content
 *   ┌ 🎲 Monopoly GO! Events | Sep 06, 2026                        ← embed title
 *   │ __**Tournaments**__                                          ← field
 *   │ <:tycoon_class:…> **Tycoon Class**
 *   │ • Start: `Sep 6, 4:00 PM`
 *   │ • End: `Sep 7, 12:59 PM`
 *   │ __**Flash Events**__
 *   │ <:HighRoller:…> **High Roller**
 *   │ • Start: … / • End: … / • Duration: `10 Minutes`
 *   │ __**Quick Wins**__
 *   │ <:pass_go:…> **Pass Go 1 time**
 *   │ • Cash / • Flags 60
 *   └ (first article image; the rest ride along as image-only embeds)
 *
 * The source link is wrapped in <angle brackets> so Discord doesn't attach a link
 * preview embed; the slug inside it is still what the daily cron's channel scan
 * matches on. The date/time strings arrive already formatted from
 * parseMonopolyEventPage and are printed as-is.
 */
export function formatMogoDiscordMessage(payload, source) {
  if (!payload?.content) return { content: "", embeds: [] };

  const parsed = splitIntoSections(payload.content);
  const dateText = extractDateFromTitle(parsed.title) || "Today";
  const title = `🎲 Monopoly GO! Events | ${dateText}`;

  // Build sections
  const tournamentsField = buildTournamentsField(parsed.sections["Tournaments"] || []);
  const flashField = buildFlashEventsField(
    parsed.sections["Special Events"] || parsed.sections["Flash Events"] || []
  );
  const quickWinsField = buildQuickWinsField(parsed.sections["Quick Wins"] || []);

  // Main embed
  const main = {
    title,
    url: payload.embeds?.[0]?.url || null,
    fields: []
  };

  // Sections are separated by a blank line appended *inside* the preceding field's
  // value (a line holding only a zero-width space). A separate spacer field with a
  // zero-width name/value renders as a gap on desktop but collapses to nothing on the
  // iOS client, so the section headers ran straight into the previous section.
  const sections = [tournamentsField, flashField, quickWinsField].filter(Boolean);
  sections.forEach((field, i) => {
    if (i < sections.length - 1) field.value = trimTo(field.value, 1022) + "\n\u200B";
  });
  main.fields.push(...sections);

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

  return { content: source ? `source: <${source}>` : "", embeds: [main, ...imageEmbeds] };
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

function buildTournamentsField(bullets) {
  const events = bullets.map(parseBullet).filter(ev => !EXCLUDED_EVENTS.test(ev.name));
  if (!events.length) return null;

  const body = events
    .map(ev => {
      const emoji = /\btycoon\s*class\b/i.test(ev.name)
        ? "<:tycoon_class:1533835656315539637>"
        : "<:main_event:1537078329939599390>";
      // Tournament duration, when the wiki gives one, is days:hours:minutes
      const duration = ev.durationHMS ? prettyTournamentDuration(ev.durationHMS) : null;
      return eventBlock(emoji, ev, duration);
    })
    .join("\n\n");

  return {
    name: "__**Tournaments**__",
    value: trimTo(body, 1024),
    inline: false
  };
}

function buildFlashEventsField(bullets) {
  const events = bullets.map(parseBullet).filter(ev => !EXCLUDED_EVENTS.test(ev.name));
  if (!events.length) return null;

  const body = events
    .map(ev => {
      // Flash event duration is hours:minutes(:seconds)
      const duration = ev.durationHMS ? prettyDuration(ev.durationHMS) : null;
      return eventBlock(pickEmoji(ev.name), ev, duration);
    })
    .join("\n\n");

  return {
    name: "__**Flash Events**__",
    value: trimTo(body, 1024),
    inline: false
  };
}

function buildQuickWinsField(bullets) {
  if (!bullets.length) return null;

  const body = bullets
    .map(b => {
      const { name, rewards } = parseQuickWin(b);
      const lines = [`${pickQuickWinEmoji(name)} **${name}**`];
      for (const r of rewards) lines.push(`• ${r}`);
      return lines.join("\n");
    })
    .join("\n\n");

  return {
    name: "__**Quick Wins**__",
    value: trimTo(body, 1024),
    inline: false
  };
}

/**
 * One event as a bold emoji + name line with Start/End bullets and, when known, a
 * Duration bullet. Markdown headings don't render inside embed fields, and the
 * bullets are literal "•" characters rather than markdown list syntax ("* " / "- "):
 * some mobile clients fold a list item into the plain-text line above it, so the
 * bullets showed up on the same line as the event name.
 */
function eventBlock(emoji, { name, start, end }, duration) {
  const lines = [
    `${emoji} **${name}**`,
    `• Start: \`${start || "Unknown"}\``,
    `• End: \`${end || "Unknown"}\``
  ];
  if (duration) lines.push(`• Duration: \`${duration}\``);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Bullet parsing (dates are already formatted upstream)              */
/* ------------------------------------------------------------------ */

/**
 * Parse a bullet line ("• **Name** — <start> → <end>  •  Duration: h:mm") into
 * structured data. The date/time strings come pre-formatted from
 * `parseMonopolyEventPage`, so they're extracted, not reformatted.
 */
function parseBullet(line) {
  const name = (line.match(/\*\*(.+?)\*\*/) || [, "Event"])[1].trim();

  // Duration is captured as h:mm, hh:mm:ss, or dd:hh:mm (we treat it as raw)
  const durMatch = line.match(/Duration:\s*([0-9]{1,3}(?::[0-9]{2}){1,2})/i);
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

  return {
    name,
    start: startRaw || null,
    end: endRaw || null,
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

/* ------------------------------------------------------------------ */
/* Misc helpers                                                       */
/* ------------------------------------------------------------------ */

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

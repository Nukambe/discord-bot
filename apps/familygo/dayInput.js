import { toEstDateString } from "../../util/dateUtils.js";

// A slash-command `date` option shared by /post-daily and /future-events: the autocomplete
// picker, the parser for what was typed, and the formatting both commands reply with.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Days offered in the date picker by default, relative to today (ET). */
const DEFAULT_SUGGESTED_DAYS = [
  { offset: -1, label: "Yesterday" },
  { offset: 0, label: "Today" },
  { offset: 1, label: "Tomorrow" },
  { offset: 2, label: "In 2 days" },
];

/**
 * Answer a `date` option's autocomplete: a typed date that parses goes first, so "10/25"
 * can be picked as-is, followed by the suggested days.
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @param {Array<{ offset: number, label: string }>} [suggestedDays]
 */
export async function respondWithDays(interaction, suggestedDays = DEFAULT_SUGGESTED_DAYS) {
  const typed = interaction.options.getFocused().trim();
  const today = estToday();
  const suggestions = suggestedDays.map(({ offset, label }) => {
    const date = addDays(today, offset);
    return { name: `${label} — ${prettyDate(date)}`, value: isoDate(date) };
  });

  const parsed = typed ? parseDay(typed, today) : null;
  const choices = parsed
    ? [{ name: prettyDate(parsed), value: isoDate(parsed) }, ...suggestions.filter((s) => s.value !== isoDate(parsed))]
    : suggestions.filter((s) => !typed || s.name.toLowerCase().includes(typed.toLowerCase()));
  await interaction.respond(choices.slice(0, 25));
}

/** Today's ET calendar date as a local-midnight Date (the form formatDateSlug reads). */
export function estToday() {
  const [y, m, d] = toEstDateString(new Date()).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** e.g. "2026-10-20" — the same shape toEstDateString produces. */
export function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * e.g. "Monday, October 19, 2026". Built by hand rather than with toLocaleDateString, which
 * the packaged build's Node runtime has been seen to format differently (see dateUtils.js).
 */
export function prettyDate(date) {
  return `${WEEKDAYS[date.getDay()]}, ${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/**
 * Read a typed day: "today" / "tomorrow" / "yesterday", "2026-10-20" (what the picker sends),
 * "10/20" or "10/20/2026", "Oct 20" or "October 20, 2026". A date without a year lands in
 * whichever year puts it nearest today, so "1/2" typed in late December means next month.
 * @param {string} input
 * @param {Date} today - local-midnight Date for today (ET)
 * @returns {Date|null} local-midnight Date, or null when it isn't a real date.
 */
export function parseDay(input, today) {
  const s = input.trim().toLowerCase();
  const relative = { yesterday: -1, today: 0, tomorrow: 1 }[s];
  if (relative !== undefined) return addDays(today, relative);

  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return realDate(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/))) return withYear(+m[1], +m[2], m[3], today);
  if ((m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/))) {
    const month = MONTHS.indexOf(m[1]) + 1;
    return month ? withYear(month, +m[2], m[3], today) : null;
  }
  return null;
}

function withYear(month, day, yearText, today) {
  if (yearText) return realDate(yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText), month, day);
  const candidates = [-1, 0, 1]
    .map((offset) => realDate(today.getFullYear() + offset, month, day))
    .filter(Boolean);
  candidates.sort((a, b) => Math.abs(a - today) - Math.abs(b - today));
  return candidates[0] ?? null;
}

/** The Date for y-m-d, or null when it rolls over (Feb 30, month 13, ...). */
function realDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

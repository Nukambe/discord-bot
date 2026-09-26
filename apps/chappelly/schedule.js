import { ALL_DAYS, atTime } from "./cronScheduler.js";

/**
 * Parsing/formatting for the human-typed halves of a cron entry: the `times`
 * list ("06:00, 18:00") and the `days` list ("daily", "Mon,Wed", "0,3") or,
 * in its place, the `dates` list ("1st, 15th, last").
 * Shared by the /cron modal (which turns typed text into env values) and
 * index.js (which turns env values into scheduler slots).
 */

const DAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DAY_NAMES = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const DAY_ALIASES = {
  daily: ALL_DAYS,
  everyday: ALL_DAYS,
  "*": ALL_DAYS,
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
};

/** "6:00" / "18:30" → "06:00" / "18:30", or null when malformed. */
export function parseHHmm(input) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(input).trim());
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/** "06:00, 18:00" → ["06:00", "18:00"] (sorted, deduped), or null if any entry is bad. */
export function parseTimes(input) {
  const times = new Set();
  for (const token of String(input).split(",").map((t) => t.trim()).filter(Boolean)) {
    const time = parseHHmm(token);
    if (!time) return null;
    times.add(time);
  }
  return times.size ? [...times].sort() : null;
}

/** "daily" / "Mon,Wed" / "0,3" → sorted day-of-week numbers, or null if any token is bad. */
export function parseDays(input) {
  const tokens = String(input).split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const days = new Set();
  for (const token of tokens) {
    if (token in DAY_ALIASES) {
      for (const d of DAY_ALIASES[token]) days.add(d);
      continue;
    }
    if (/^[0-6]$/.test(token)) {
      days.add(Number(token));
      continue;
    }
    if (!(token in DAY_NAMES)) return null;
    days.add(DAY_NAMES[token]);
  }
  return days.size ? [...days].sort((a, b) => a - b) : null;
}

/** Env `days` as stored (possibly hand-edited) → valid day numbers, or every day when unset. */
export function normalizeDays(days) {
  if (!Array.isArray(days)) return [...ALL_DAYS];
  const valid = [...new Set(days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  return valid.length ? valid.sort((a, b) => a - b) : [...ALL_DAYS];
}

export function daysToLabel(days) {
  const normalized = normalizeDays(days);
  if (normalized.length === ALL_DAYS.length) return "daily";
  return normalized.map((d) => DAY_SHORT_NAMES[d]).join(",");
}

/**
 * Dates of the month ("1st", "15th", "last") — the other thing the modal's
 * Days box accepts. The scheduler only knows weekly slots, so a dated cron is
 * stored as `days: every day` plus `dates: [1, 15]` and gated at run time
 * (see dateStatus). A date past the month's end fires on its last day, which
 * is what makes 31 mean "last": the 31st is Feb 28/29, Apr 30, and so on.
 */
export const LAST_DAY = 31;
const DATE_TOKEN = /^(\d{1,2})(st|nd|rd|th)$/;

const ordinal = (n) => {
  if (n === LAST_DAY) return "last";
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] ?? "th";
  return `${n}${suffix}`;
};

/** Env `dates` as stored (possibly hand-edited) → sorted 1–31, or null when the cron isn't dated. */
export function normalizeDates(dates) {
  if (!Array.isArray(dates)) return null;
  const valid = new Set();
  for (const raw of dates) {
    const n = String(raw).trim().toLowerCase() === "last" ? LAST_DAY : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= LAST_DAY) valid.add(n);
  }
  return valid.size ? [...valid].sort((a, b) => a - b) : null;
}

export const datesToLabel = (dates) => (normalizeDates(dates) ?? []).map(ordinal).join(", ");

/**
 * The modal's Days box: weekdays ("daily", "Mon,Wed", "0,3") or dates of the
 * month ("1st, 15th, last"), not both — "Mon, 1st" has no obvious meaning.
 * Bare digits stay weekdays, as they always were, which is why dates need
 * their ordinal suffix.
 * @returns {{ days: number[], dates: number[]|null }|null} null when malformed.
 */
export function parseDayField(input) {
  const tokens = String(input).split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const dateTokens = tokens.filter((t) => t === "last" || DATE_TOKEN.test(t));
  if (!dateTokens.length) {
    const days = parseDays(input);
    return days ? { days, dates: null } : null;
  }
  if (dateTokens.length !== tokens.length) return null;
  const dates = dateTokens.map((t) => (t === "last" ? LAST_DAY : Number(DATE_TOKEN.exec(t)[1])));
  if (dates.some((n) => n < 1 || n > LAST_DAY)) return null;
  return { days: [...ALL_DAYS], dates: normalizeDates(dates) };
}

/** What the Days box shows (and re-parses) for a cron. */
export const dayFieldLabel = (cron) => {
  const dates = normalizeDates(cron?.dates);
  return dates ? datesToLabel(dates) : daysToLabel(cron?.days);
};

/**
 * The dates gate for a dated cron: due when today (an ET "YYYY-MM-DD") is one
 * of its `dates`, with dates past the month's end clamped to its last day.
 * An undated cron is always due.
 * @returns {{ dates: number[]|null, due: boolean }}
 */
export function dateStatus(cron, today) {
  const dates = normalizeDates(cron?.dates);
  if (!dates || !DATE_PATTERN.test(today ?? "")) return { dates, due: true };
  const [y, m, d] = today.split("-").map(Number);
  const monthLength = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { dates, due: dates.some((date) => Math.min(date, monthLength) === d) };
}

export const timesToLabel = (times) => (Array.isArray(times) ? times : []).join(", ");

/** Env `everyDays` as stored (possibly a string from /env set) → integer ≥ 2, or null when not an interval cron. */
export function normalizeEveryDays(everyDays) {
  const n = Number(everyDays);
  return Number.isInteger(n) && n >= 2 ? n : null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Whole calendar days from `from` to `to` ("YYYY-MM-DD" each), or null if either is malformed. */
export function daysBetween(from, to) {
  if (!DATE_PATTERN.test(from ?? "") || !DATE_PATTERN.test(to ?? "")) return null;
  const ms = Date.UTC(...splitDate(to)) - Date.UTC(...splitDate(from));
  return Math.round(ms / 86_400_000);
}

/** "YYYY-MM-DD" plus `n` days. */
export function addDays(date, n) {
  if (!DATE_PATTERN.test(date ?? "")) return null;
  const d = new Date(Date.UTC(...splitDate(date)) + n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const splitDate = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m - 1, d];
};

/**
 * Scheduler slots for a cron entry. Throws on a malformed time so the
 * scheduler logs and skips that one cron rather than guessing.
 */
export function cronSlots(cron) {
  const days = normalizeDays(cron.days);
  const times = Array.isArray(cron.times) ? cron.times : [];
  return times.flatMap((raw) => {
    const time = parseHHmm(raw);
    if (!time) throw new Error(`Invalid time "${raw}" — expected HH:mm (24h ET).`);
    const [hour, minute] = time.split(":").map(Number);
    return atTime(hour, minute, days);
  });
}

/**
 * The interval gate for an `everyDays` cron, shared by every job type: a cron
 * without `everyDays` is always due, and one with it is due once that many
 * whole days have passed since `lastRun`. An unset or malformed `lastRun`
 * counts as due, so a hand-edited env can't wedge a cron permanently.
 * @returns {{ everyDays: number|null, since: number|null, due: boolean }}
 */
export function intervalStatus(cron, today) {
  const everyDays = normalizeEveryDays(cron?.everyDays);
  if (!everyDays) return { everyDays: null, since: null, due: true };
  const since = daysBetween(cron?.lastRun, today);
  return { everyDays, since, due: since === null || since >= everyDays };
}

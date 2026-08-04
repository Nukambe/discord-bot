/**
 * Convert a Date into the slug format used by the site, e.g. "Nov 11, 2025" -> "nov-11-2025"
 * @param {Date} d
 * @returns {string} e.g. "nov-11-2025"
 */
export function formatDateSlug(d) {
  const mons = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const mm = mons[d.getMonth()];
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

/**
 * Get tomorrow's date in Monopoly GO slug format.
 * @returns {string} e.g. "nov-12-2025"
 */
export function getTomorrowSlug() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  return formatDateSlug(tomorrow);
}

// Helper to format tomorrow's date nicely (e.g., "Wednesday, November 13, 2025")
export function getTomorrowPrettyDate() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function getTodayPrettyDate() {
  const today = new Date();
  return today.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Format a Date's calendar date in America/New_York as "YYYY-MM-DD".
 * Reads typed parts (year/month/day) from Intl.DateTimeFormat rather than parsing a
 * locale-formatted string — the packaged/pkg build's Node runtime has been observed to
 * format `toLocaleDateString('en-CA', ...)` differently than plain Node (e.g. "8/1/2026"
 * instead of "2026-08-01"), which silently breaks split("-")-based parsing.
 * @param {Date} date
 * @returns {string} e.g. "2026-08-01"
 */
export function toEstDateString(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * Get the current time-of-day in America/New_York, read via typed parts (not
 * a parsed locale string) for the same reason as toEstDateString above.
 * @param {Date} date
 * @returns {{hour: number, minute: number}}
 */
export function toEstTimeParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return { hour: Number(map.hour), minute: Number(map.minute) };
}

/**
 * Get yesterday's calendar date in America/New_York, as "YYYY-MM-DD".
 * Used to find posts published "the day before" relative to an America/New_York midnight cron.
 * @returns {string} e.g. "2026-08-01"
 */
export function getYesterdayEstDateString() {
  const [y, m, d] = toEstDateString(new Date()).split("-").map(Number);
  const yesterday = new Date(y, m - 1, d - 1);
  const yyyy = yesterday.getFullYear();
  const mm = String(yesterday.getMonth() + 1).padStart(2, "0");
  const dd = String(yesterday.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
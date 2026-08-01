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
 * Get yesterday's calendar date in America/New_York, as "YYYY-MM-DD".
 * Used to find posts published "the day before" relative to an America/New_York midnight cron.
 * @returns {string} e.g. "2026-08-01"
 */
export function getYesterdayEstDateString() {
  const todayEst = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
  const [y, m, d] = todayEst.split("-").map(Number);
  const yesterday = new Date(y, m - 1, d - 1);
  const yyyy = yesterday.getFullYear();
  const mm = String(yesterday.getMonth() + 1).padStart(2, "0");
  const dd = String(yesterday.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
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
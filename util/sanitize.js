// apps/twitch/lib/sanitize.js

// Regex collections for performance
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const NEWLINES = /[\r\n]+/g;
const ZALGO = /[\u0300-\u036F\u0483-\u0489]+/g; // diacritics used for zalgo text

export function sanitizeInput(message) {
  if (!message || typeof message !== "string") return "";

  let m = message;

  // Normalize unicode (fixes weird lookalikes, ligatures, emoji variations)
  m = m.normalize("NFKC");

  // Strip IRC-breaking control chars
  m = m.replace(CONTROL_CHARS, "");

  // Strip newlines (Twitch won't allow them anyway)
  m = m.replace(NEWLINES, " ");

  // Remove invisible zero-width characters
  m = m.replace(ZERO_WIDTH, "");

  // Light Zalgo cleanup
  m = m.replace(ZALGO, "");

  // Prevent forced pings (@everyone / @username spam)
  m = m.replace(/@/g, "[@]");

  // Collapse excessive spacing
  m = m.replace(/\s{2,}/g, " ").trim();

  return m;
}

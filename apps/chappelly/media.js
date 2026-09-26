import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Images a reminder can attach, kept in apps/chappelly/media/ and shipped with
 * the code. A cron's `image` names a file in here rather than holding a URL
 * because Discord's own attachment URLs are signed and expire within a day, so
 * "upload it once and store the link" doesn't survive.
 */

export const MEDIA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "media");

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;

/** Every attachable file name in media/, sorted. Empty when the folder is missing. */
export function listMedia() {
  try {
    return fs.readdirSync(MEDIA_DIR).filter((name) => IMAGE_EXTENSIONS.test(name)).sort();
  } catch {
    return [];
  }
}

/**
 * Absolute path of media file `name`, or null when it isn't one — only a bare
 * file name that exists in media/ resolves, so an env value can't point the
 * bot at anything else on disk.
 */
export function resolveMedia(name) {
  const file = String(name ?? "").trim();
  if (!file || file !== path.basename(file) || !listMedia().includes(file)) return null;
  return path.join(MEDIA_DIR, file);
}

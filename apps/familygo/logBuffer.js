/**
 * In-memory capture of everything the process writes to stdout/stderr, so
 * /dump-logs can post it to Discord. The packaged desktop build writes no log
 * file — its console window is the only record, and it's gone the moment the
 * window closes — so this buffer is the only way to get history off the
 * user's machine after the fact.
 *
 * Hooks the streams rather than console.* so it also catches things that
 * bypass console: node-cron's own logger, Node deprecation/process warnings,
 * Playwright output. Installed as an import side effect — this module must be
 * imported before anything that logs (first import in launch.js and index.js;
 * both is fine, install is idempotent and the buffer is a module singleton).
 *
 * Ring buffer: only the newest MAX_LINES lines are kept.
 */

const MAX_LINES = 4000;

const lines = [];
let installed = false;

function record(stream, chunk) {
  const text = typeof chunk === "string" ? chunk : chunk?.toString?.("utf8");
  if (!text) return;

  const stamp = new Date().toISOString();
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    lines.push(`[${stamp}] [${stream}] ${line}`);
  }
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

function install() {
  if (installed) return;
  installed = true;

  for (const [stream, tag] of [[process.stdout, "out"], [process.stderr, "err"]]) {
    const original = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      try {
        record(tag, chunk);
      } catch {
        // Capturing must never break the write itself.
      }
      return original(chunk, encoding, callback);
    };
  }
}

install();

/**
 * The captured log, oldest line first.
 * @returns {string}
 */
export function getLogText() {
  return lines.join("\n");
}

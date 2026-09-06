import { readFile } from "fs/promises";
import { parseMonopolyEventPage } from "../getEvent.js";
import path from "path";
import { fileURLToPath } from "url";
import { formatMogoDiscordMessage } from "../formatEvent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Default fixture (not checked in); pass a saved "Today's Events" page as the first
// argument instead: node apps/familygo/tests/getEvent.test.js ./debug/monopolygo-event.html
const FIXTURE = process.argv[2] || path.join(__dirname, "../../../monopolygo-event_2025-11-11T19-02-35-441Z.html");

/**
 * Load the saved Monopoly GO event HTML and parse it.
 */
async function test() {
  try {
    const html = await readFile(FIXTURE, "utf8");

    const data = parseMonopolyEventPage(html, { debug: false });
    const formatted = formatMogoDiscordMessage(data, "https://monopolygo.wiki/todays-events-example");
    console.log(JSON.stringify(formatted, null, 2));
  } catch (err) {
    console.error("[test] Failed:", err);
  }
}

test();

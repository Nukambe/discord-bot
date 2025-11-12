import { readFile } from "fs/promises";
import { parseMonopolyEventPage } from "../getEvent.js";
import path from "path";
import { fileURLToPath } from "url";
import { formatMogoDiscordMessage } from "../formatEvent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.join(__dirname, "../../../monopolygo-event_2025-11-11T19-02-35-441Z.html");

/**
 * Load the saved Monopoly GO event HTML and parse it.
 */
async function test() {
  try {
    const html = await readFile(FIXTURE, "utf8");

    const data = parseMonopolyEventPage(html, { debug: false });
    const formatted = formatMogoDiscordMessage(data);
    console.log(formatted);
  } catch (err) {
    console.error("[test] Failed:", err);
  }
}

test();

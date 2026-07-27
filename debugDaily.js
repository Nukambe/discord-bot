/**
 * Debug runner for the daily post pipeline.
 *
 * Mirrors postEventToDiscord() but turns on the `debug` options that the real
 * path never passes, and stops before posting — so it can be run against the
 * live wiki without touching the Discord channel.
 *
 *   node debugDaily.js              # today
 *   node debugDaily.js jul-27-2026  # explicit date slug
 *
 * Writes the fetched HTML to ./monopolygo-events.html and ./monopolygo-event.html.
 */
import "dotenv/config";
import { formatDateSlug } from "./util/dateUtils.js";
import { getMogoWikiEvents, getEventUrlFromHtml, getMogoEventPage } from "./apps/familygo/getEvents.js";
import { parseMonopolyEventPage } from "./apps/familygo/getEvent.js";
import { formatMogoDiscordMessage } from "./apps/familygo/formatEvent.js";

const dateSlug = process.argv[2] || formatDateSlug(new Date());
console.log(`🌀 Debug run for: ${dateSlug}`);
console.log(`   CHROME_PATH=${process.env.CHROME_PATH || "(unset — will use Heroku path)"}`);
console.log(`   CHROME_HEADLESS=${process.env.CHROME_HEADLESS ?? "(unset — headless)"}\n`);

const eventsHtml = await getMogoWikiEvents({ debug: true });
if (!eventsHtml) {
    console.error("❌ Unable to retrieve HTML from Mogo Wiki");
    process.exit(1);
}
console.log(`✅ Events index: ${eventsHtml.length} bytes\n`);

const url = getEventUrlFromHtml(eventsHtml, dateSlug, { debug: true });
if (!url) {
    console.warn(`⚠️ No event URL found for ${dateSlug} — see the anchor dump above.`);
    process.exit(1);
}
console.log(`🔗 ${url}\n`);

const eventHtml = await getMogoEventPage(url, { debug: true });
if (!eventHtml) {
    console.error("❌ Unable to fetch event page");
    process.exit(1);
}
console.log(`✅ Event page: ${eventHtml.length} bytes\n`);

const data = parseMonopolyEventPage(eventHtml);
if (!data) {
    console.error("❌ Failed to parse event page");
    process.exit(1);
}
console.log("🧩 Parsed data:");
console.dir(data, { depth: null });

const formatted = formatMogoDiscordMessage(data, url);
console.log("\n🖋️ Content:\n" + formatted.content);
console.log(`\n📦 Embeds (${formatted.embeds.length}):`);
console.dir(formatted.embeds, { depth: null });
console.log("\n🏁 Debug run complete — nothing was posted to Discord.");

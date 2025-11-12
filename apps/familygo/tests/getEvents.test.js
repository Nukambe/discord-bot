import { formatDateSlug, getTomorrowSlug } from "../../../util/dateUtils.js";
import { getEventUrlFromHtml, getMogoEventPage, getMogoWikiEvents } from "../getEvents.js";

async function eventsTest() {
    const html = await getMogoWikiEvents();
    if (!html) {
        console.log("Unable to retrieve HTML");
        return;
    }
    const dateSlug = formatDateSlug(new Date());
    console.log("Date:", dateSlug);
    console.log("slug present?:", html.includes(`/todays-events-${dateSlug}`));
    const url = getEventUrlFromHtml(html, dateSlug, { debug: true });
    console.log("URL:", url);
}

async function eventTest() {
    const html = getMogoEventPage("https://monopolygo.wiki/todays-events-nov-11-2025-battleship/", { debug: true });
}

// await eventsTest();
await eventTest();
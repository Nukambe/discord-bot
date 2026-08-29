import { toEstDateString } from "../../../util/dateUtils.js";
import { getMogoWikiCalendar, getCalendarEvents } from "../getWeeklyEvents.js";
import { formatWeeklyPredictions, getUpcomingMondayEstDate } from "../postWeeklyPredictions.js";

// Fetches the live /events calendar (opens a Chrome window) and prints the
// weekly-predictions post for the upcoming Monday–Sunday, for manual inspection.
async function weeklyEventsTest() {
    const html = await getMogoWikiCalendar({ debug: true });
    if (!html) {
        console.log("Unable to retrieve HTML");
        return;
    }

    const all = getCalendarEvents(html, { debug: true });
    console.log(`Parsed ${all.length} calendar events`);
    for (const ev of all) {
        console.log(`  ${ev.eventKey || "?"} | ${ev.title} | ${ev.start.toISOString()} -> ${ev.end.toISOString()}`);
    }

    const mondayDate = getUpcomingMondayEstDate();
    console.log("Upcoming Monday:", mondayDate);

    const [y, m, d] = mondayDate.split("-").map(Number);
    const weekDates = Array.from({ length: 7 }, (_, i) => {
        const day = new Date(y, m - 1, d + i);
        return [
            day.getFullYear(),
            String(day.getMonth() + 1).padStart(2, "0"),
            String(day.getDate()).padStart(2, "0"),
        ].join("-");
    });

    const weekSet = new Set(weekDates);
    const excluded = /milestone|tournament/i;
    const events = all.filter((ev) =>
        weekSet.has(toEstDateString(ev.start)) && !excluded.test(ev.eventKey) && !excluded.test(ev.title)
    );

    console.log("\n===== formatted post =====\n");
    console.log(formatWeeklyPredictions(events, weekDates).join("\n\n"));
}

await weeklyEventsTest();

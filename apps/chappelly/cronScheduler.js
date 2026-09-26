/**
 * One fire time per distinct minute, not one cron per job — the same scheduler
 * familygo uses (apps/familygo/cronScheduler.js), kept as chappelly's own copy
 * since the apps share no runtime.
 *
 * Every job declares the discrete minutes it wants to run at (its "slots"),
 * and this module:
 *   1. expands every job's slots for the current env,
 *   2. buckets them by slot, so a slot knows every job that wants that minute,
 *   3. ticks once a minute on its own timer and runs, one after another, every
 *      job whose slot fell inside the minutes since the previous tick.
 *
 * Every run shares a single serial queue, so a job that runs long can never
 * overlap the next slot's work either. Recompute and restart the whole set
 * whenever the env changes (see `startScheduler`).
 *
 * Why a ticker of our own and not node-cron: v4 fires each expression from one
 * long `setTimeout` and then insists the second hand reads :00 when it lands.
 * A timer landing a second late doesn't run the task — it's logged as a
 * "missed execution" and skipped, or not logged at all when it's the
 * expression's first fire since boot — which is how familygo lost a whole
 * 7:30pm slot with the process up. Ticking against elapsed *minutes* instead
 * means a late timer or a stalled event loop resolves the same way: the next
 * tick sees the minutes that went by and runs what they were due.
 *
 * Slots are America/New_York wall times, and each elapsed minute is read as
 * one by walking the clock (`estSlot`), so a 06:00 slot fires at 6am Eastern
 * year-round, whether that is EST or EDT — nothing here needs to shift by an
 * hour in March/November.
 *
 * Unlike familygo's copy there is no startup catch-up: a reminder has no
 * "already posted?" check to make a second run harmless, so a slot the dyno
 * was down for is simply gone, as it always was.
 */

const TIMEZONE = "America/New_York";
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const MS_PER_MINUTE = 60 * 1000;

/**
 * How far past the minute boundary a tick aims for. Timers never fire early,
 * but landing a hair after the boundary keeps a tick from ever straddling it.
 */
const TICK_MARGIN_MS = 1000;

/**
 * The longest stretch of missed minutes a tick will look back over. Every slot
 * repeats at least weekly and each job runs at most once per tick anyway, so a
 * gap longer than a week has nothing older to offer.
 */
const MAX_GAP_MINUTES = MINUTES_PER_WEEK;

/** cron day-of-week values, 0 = Sunday. */
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Slots for a fixed time of day on the given days. */
export const atTime = (hour, minute, days = ALL_DAYS) =>
    days.map(dow => ({ dow, hour, minute }));

/**
 * Slots for a retry window: the first attempt lands exactly on the start time,
 * then every `intervalMinutes` until the end time inclusive. A window whose end
 * is at or before its start is treated as spilling into the following day, and
 * slots roll onto the next day's day-of-week accordingly. `days` lists the days
 * the window *starts* on.
 */
export const windowSlots = ({
    startHour,
    startMinute,
    endHour,
    endMinute,
    intervalMinutes,
    days = ALL_DAYS,
}) => {
    const interval = Math.max(1, Math.round(intervalMinutes) || 1);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    // Wrap past midnight when the window closes at or before it opens.
    const span = end > start ? end - start : MINUTES_PER_DAY - start + end;

    const slots = [];
    for (const dow of days) {
        for (let offset = 0; offset <= span; offset += interval) {
            const absolute = (dow * MINUTES_PER_DAY + start + offset) % MINUTES_PER_WEEK;
            slots.push({
                dow: Math.floor(absolute / MINUTES_PER_DAY),
                hour: Math.floor((absolute % MINUTES_PER_DAY) / 60),
                minute: absolute % 60,
            });
        }
    }
    return slots;
};

const slotKey = ({ dow, hour, minute }) => `${dow}:${hour}:${minute}`;

const formatSlotTime = ({ hour, minute }) =>
    `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/**
 * An instant as a slot: its America/New_York weekday, hour and minute, read
 * from typed Intl parts rather than a parsed locale string. One formatter,
 * since a tick after a long stall asks this for every minute it missed.
 */
const EST_PARTS = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const estSlot = (date) => {
    const map = {};
    for (const part of EST_PARTS.formatToParts(date)) map[part.type] = part.value;
    return { dow: WEEKDAYS.indexOf(map.weekday), hour: Number(map.hour), minute: Number(map.minute) };
};

/** A UTC minute index (ms since the epoch / 60000), which is what the ticker counts in. */
const minuteOf = (date) => Math.floor(date.getTime() / MS_PER_MINUTE);
const minuteToDate = (minute) => new Date(minute * MS_PER_MINUTE);

/**
 * Expand every job's slots against the env and bucket them by slot, so a slot
 * knows every job that wants that minute. Within a slot, jobs keep the order
 * they appear in `jobs`. A job whose `slots()` throws (a malformed cron written
 * by a direct env edit, say) is logged and left out so it can't take the rest
 * of the schedule down with it.
 * @returns {Map<string, { slot: object, jobs: object[] }>} keyed by slotKey.
 */
const bucketSlots = (jobs, ctx) => {
    const bySlot = new Map();
    for (const job of jobs) {
        let slots;
        try {
            slots = job.slots(ctx) ?? [];
        } catch (err) {
            console.error(`💥 Could not resolve schedule for job "${job.name}":`, err);
            continue;
        }
        for (const slot of slots) {
            const key = slotKey(slot);
            if (!bySlot.has(key)) bySlot.set(key, { slot, jobs: [] });
            const bucket = bySlot.get(key);
            if (!bucket.jobs.includes(job)) bucket.jobs.push(job);
        }
    }
    return bySlot;
};

/**
 * Compile a set of slots into the fewest cron expressions that fire on exactly
 * those minutes: days that fire at identical times share one expression, and
 * within them each minute-of-hour collapses its hours into one hour list.
 * Nothing runs off these any more — they're the readable summary of a schedule
 * for the startup log, in a notation anyone can check against the env.
 */
const compileExpressions = (slots) => {
    const timesByDay = new Map(); // dow -> Set("hour:minute")
    for (const slot of slots) {
        if (!timesByDay.has(slot.dow)) timesByDay.set(slot.dow, new Set());
        timesByDay.get(slot.dow).add(`${slot.hour}:${slot.minute}`);
    }

    // Merge days whose fire times match exactly.
    const dayGroups = new Map(); // signature -> { dows, times }
    for (const [dow, times] of timesByDay) {
        const sorted = [...times].sort();
        const signature = sorted.join("|");
        if (!dayGroups.has(signature)) dayGroups.set(signature, { dows: [], times: sorted });
        dayGroups.get(signature).dows.push(dow);
    }

    const expressions = [];
    for (const { dows, times } of dayGroups.values()) {
        const dayField = dows.length === ALL_DAYS.length
            ? "*"
            : [...dows].sort((a, b) => a - b).join(",");

        const hoursByMinute = new Map(); // minute -> Set(hour)
        for (const time of times) {
            const [hour, minute] = time.split(":").map(Number);
            if (!hoursByMinute.has(minute)) hoursByMinute.set(minute, new Set());
            hoursByMinute.get(minute).add(hour);
        }

        for (const [minute, hours] of hoursByMinute) {
            const hourField = hours.size === 24
                ? "*"
                : [...hours].sort((a, b) => a - b).join(",");
            expressions.push({ expression: `${minute} ${hourField} * * ${dayField}`, minute, hours });
        }
    }
    return expressions;
};

/**
 * Resolve job definitions against the current env into a readable schedule:
 * `[{ expression, jobs }]`, where every expression fires on a set of minutes no
 * other expression in the list fires on.
 *
 * Each job is `{ name, slots(ctx) -> slot[], run(ctx) }`. Within a slot, jobs
 * run in the order they appear in `jobs`.
 */
export const buildSchedule = (jobs, ctx) => {
    // Slots wanting the same jobs can share expressions, which is what keeps the
    // line count near the number of interesting times rather than of minutes.
    const byJobSet = new Map(); // job-name signature -> { jobs, slots }
    for (const { slot, jobs: slotJobs } of bucketSlots(jobs, ctx).values()) {
        const signature = slotJobs.map(job => job.name).join(" > ");
        if (!byJobSet.has(signature)) byJobSet.set(signature, { jobs: slotJobs, slots: [] });
        byJobSet.get(signature).slots.push(slot);
    }

    const schedule = [];
    for (const { jobs: groupJobs, slots } of byJobSet.values()) {
        for (const { expression } of compileExpressions(slots)) {
            schedule.push({ expression, jobs: groupJobs });
        }
    }
    return schedule;
};

/**
 * The jobs with a slot in the UTC minutes `(from, to]`, each at most once, with
 * the latest such slot. Walking the range minute by minute and reading each
 * instant as an ET slot is what makes it DST-proof: a 06:00 slot is whichever
 * UTC minute reads 06:00 in New York that day.
 *
 * "At most once" is deliberate: a reminder that missed several of its times
 * over a long stall is one reminder to send, not several.
 *
 * @param {object[]} jobs - In the order they should run.
 * @param {Map<string, { slot: object, jobs: object[] }>} buckets - From bucketSlots.
 * @param {number} from - UTC minute index, exclusive.
 * @param {number} to - UTC minute index, inclusive.
 * @returns {Array<{ job: object, slot: object }>} in `jobs` order.
 */
const dueBetween = (jobs, buckets, from, to) => {
    const latestSlot = new Map(); // job -> slot
    for (let minute = Math.max(from + 1, to - MAX_GAP_MINUTES + 1); minute <= to; minute++) {
        const bucket = buckets.get(slotKey(estSlot(minuteToDate(minute))));
        if (!bucket) continue;
        for (const job of bucket.jobs) latestSlot.set(job, bucket.slot);
    }
    return jobs.filter(job => latestSlot.has(job)).map(job => ({ job, slot: latestSlot.get(job) }));
};

/**
 * Start the schedule. Returns a handle whose `stop()` halts the ticker, so an
 * env change can rebuild the whole set:
 *
 *   scheduler?.stop();
 *   scheduler = startScheduler(buildJobs(env), { client, env });
 */
export const startScheduler = (jobs, ctx) => {
    const buckets = bucketSlots(jobs, ctx);
    const schedule = buildSchedule(jobs, ctx);

    // Shared across every tick: two slots can't run at once, and a job that
    // overruns its slot delays the next one instead of racing it.
    let queue = Promise.resolve();

    const enqueue = (queuedJobs) => {
        queue = queue.then(async () => {
            for (const job of queuedJobs) {
                try {
                    await job.run(ctx);
                } catch (err) {
                    console.error(`💥 Cron job "${job.name}" failed:`, err);
                }
            }
        });
    };

    // The last UTC minute a tick has accounted for. Each tick settles every
    // minute from here up to the one it lands in, so however late it arrives
    // nothing in between is skipped, and a minute is never settled twice.
    let cursor = minuteOf(new Date());
    let running = true;
    let timer = null;

    const scheduleTick = () => {
        if (!running) return;
        const nowMs = Date.now();
        const nextBoundary = (Math.floor(nowMs / MS_PER_MINUTE) + 1) * MS_PER_MINUTE;
        timer = setTimeout(tick, nextBoundary + TICK_MARGIN_MS - nowMs);
    };

    const tick = () => {
        if (!running) return;
        const nowMinute = minuteOf(new Date());
        const gap = nowMinute - cursor;
        if (gap > 1) {
            console.log(`⏱️ [chappelly] ${gap - 1} minute(s) passed without a tick (late timer or stall) — settling them now`);
        }
        const due = dueBetween(jobs, buckets, cursor, nowMinute);
        cursor = nowMinute;
        if (due.length) {
            console.log(
                `⏰ [chappelly] ${formatSlotTime(estSlot(new Date()))} ET → ` +
                    due.map(({ job, slot }) => `${job.name} (${formatSlotTime(slot)})`).join(", ")
            );
            enqueue(due.map(({ job }) => job));
        }
        scheduleTick();
    };

    scheduleTick();

    console.log(`⏰ [chappelly] Scheduled ${schedule.length} fire time(s) across ${jobs.length} job(s) (${TIMEZONE}):`);
    for (const { expression, jobs: slotJobs } of schedule) {
        console.log(`   ${expression.padEnd(30)} → ${slotJobs.map(job => job.name).join(", ")}`);
    }

    return {
        schedule,
        stop() {
            running = false;
            clearTimeout(timer);
            timer = null;
        },
    };
};

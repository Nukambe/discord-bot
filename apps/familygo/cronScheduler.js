/**
 * One fire time per distinct minute, not one cron per job — driven by a single
 * minute ticker of our own rather than by node-cron.
 *
 * familygo's jobs used to each own a `cron.schedule` call, and several of them
 * resolved to the same wall-clock minute (the daily post, free dice, the gift
 * rotation and the weekly predictions all defaulted to 7:30pm ET). Every wiki
 * fetch opens a *visible* Chrome window on the packaged desktop build —
 * Cloudflare rejects headless, see util/fetchWithPlaywright.js — so coinciding
 * jobs meant several browser windows popping up in an end user's face at once.
 *
 * Instead, every job declares the discrete minutes it wants to run at (its
 * "slots"), and this module:
 *   1. expands every job's slots for the current config,
 *   2. buckets them by slot, so a slot knows every job that wants that minute,
 *   3. ticks once a minute and runs, one after another, every job whose slot
 *      fell inside the minutes since the previous tick.
 *
 * Why not node-cron: v4 fires each expression from one long `setTimeout` and
 * then insists the second hand reads :00 when it lands. On the Windows desktop
 * build those timers routinely land a second late (background timer
 * coalescing), and a late landing doesn't run the task — it's logged as a
 * "missed execution" and skipped, or not logged at all when it's the
 * expression's first fire since boot. That is how a whole 7:30pm slot went by
 * with nothing running. Ticking against elapsed *minutes* instead means a late
 * timer, a stalled event loop or a laptop lid closed over the slot all resolve
 * the same way: the next tick sees the minutes that went by and runs what they
 * were due (see `dueBetween`).
 *
 * On top of that, every run shares a single serial queue, so a job that runs
 * long can never overlap the next slot's work either. Recompute and restart the
 * whole set whenever the config changes (see `startScheduler`).
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
 * gap longer than a week (the machine was off) has nothing older to offer.
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
 * is at or before its start is treated as spilling into the following day (the
 * daily post's 19:30 → 15:30 window), and slots roll onto the next day's
 * day-of-week accordingly. `days` lists the days the window *starts* on.
 *
 * Stepping from the start time rather than from the top of the hour means an
 * off-grid window start (19:45, say) actually gets an attempt at 19:45, which is
 * what the config describes; with the default half-hour values the resulting
 * slots are identical to the old every-30-minutes ticks, minus the out-of-window
 * no-ops.
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
 * An instant as a slot: its America/New_York weekday, hour and minute. Read
 * from typed Intl parts rather than a parsed locale string, for the same reason
 * as util/dateUtils.js — the packaged build's Node formats those strings
 * differently than plain Node does. One formatter, since a tick after a long
 * sleep asks this for every minute it slept through.
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
 * Expand every job's slots against the config and bucket them by slot, so a
 * slot knows every job that wants that minute. Within a slot, jobs keep the
 * order they appear in `jobs`.
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
 * for the startup log, in a notation anyone can check against the config.
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
 * Resolve job definitions against the current config into a readable schedule:
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
 * the latest such slot — the one question both the ticker and the startup
 * catch-up ask. Walking the range minute by minute and reading each instant as
 * an ET slot is what makes it DST-proof: a 19:30 slot is whichever UTC minute
 * reads 19:30 in New York that day, and nothing here has to know when the
 * clocks change.
 *
 * "At most once" is deliberate. A job that missed several slots (the daily
 * post's half-hourly retries over a two-hour sleep, say) has one thing to catch
 * up on, not four — every job answers "is this already done?" before it does
 * any work, so the extra runs would only be browser windows.
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
 * The jobs whose slot for today has already gone by at `now` — i.e. what a
 * process starting up right now would have been down for.
 *
 * This can't know whether the process was actually running at that minute, so a
 * catch-up run may well be redundant — every job answers "is this already done?"
 * from Discord or the db before it does any work, so a redundant run is a cheap
 * no-op. The exception is the gift rotation, which isn't idempotent: it decides
 * for itself, off the `catchUp` flag startScheduler passes into `run`.
 *
 * @param {Array<{name: string, slots: Function, run: Function}>} jobs
 * @param {object} ctx - Same ctx the jobs' `slots()` get.
 * @param {Date} [now]
 * @returns {Array<{ job: object, slot: object }>} in `jobs` order.
 */
export const missedJobs = (jobs, ctx, now = new Date()) => {
    const { hour, minute } = estSlot(now);
    const nowMinute = minuteOf(now);
    // From ET midnight (inclusive) — the range's `from` is exclusive, hence the -1.
    return dueBetween(jobs, bucketSlots(jobs, ctx), nowMinute - (hour * 60 + minute) - 1, nowMinute);
};

/**
 * Start the schedule. Returns a handle whose `stop()` halts the ticker, so a
 * config change can rebuild the whole set:
 *
 *   scheduler?.stop();
 *   scheduler = startScheduler(JOBS, { client, db });
 *
 * `opts.catchUp` additionally runs, once, every job whose slot for today has
 * already passed (see missedJobs) — what keeps a bot started at 8pm from sitting
 * out the 7:30pm slot until tomorrow. It goes through the same serial queue as
 * the ticks, so the catch-up sweep still opens one browser window at a time
 * and can't race a slot that fires while it's working. Pass it only on the first
 * call: an onDbChange rebuild would otherwise re-sweep on every config edit.
 */
export const startScheduler = (jobs, ctx, opts = {}) => {
    const { catchUp = false } = opts;
    const buckets = bucketSlots(jobs, ctx);
    const schedule = buildSchedule(jobs, ctx);

    // Shared across every tick: two slots can't run at once, and a job that
    // overruns its slot delays the next one instead of racing it for a browser.
    let queue = Promise.resolve();

    const enqueue = (queuedJobs, runCtx) => {
        queue = queue.then(async () => {
            for (const job of queuedJobs) {
                try {
                    await job.run(runCtx);
                } catch (err) {
                    console.error(`💥 Cron job "${job.name}" failed:`, err);
                }
            }
        });
    };

    // The last UTC minute a tick has accounted for. Each tick settles every
    // minute from here up to the one it lands in, so however late it arrives —
    // a coalesced timer, a blocked event loop, a machine asleep for the evening
    // — nothing in between is skipped, and a minute is never settled twice.
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
            console.log(`⏱️ ${gap - 1} minute(s) passed without a tick (late timer or sleep) — settling them now`);
        }
        const due = dueBetween(jobs, buckets, cursor, nowMinute);
        cursor = nowMinute;
        if (due.length) {
            console.log(
                `⏰ ${formatSlotTime(estSlot(new Date()))} ET → ` +
                    due.map(({ job, slot }) => `${job.name} (${formatSlotTime(slot)})`).join(", ")
            );
            enqueue(due.map(({ job }) => job), ctx);
        }
        scheduleTick();
    };

    scheduleTick();

    console.log(`⏰ Scheduled ${schedule.length} fire time(s) across ${jobs.length} job(s) (${TIMEZONE}):`);
    for (const { expression, jobs: slotJobs } of schedule) {
        console.log(`   ${expression.padEnd(30)} → ${slotJobs.map(job => job.name).join(", ")}`);
    }

    if (catchUp) {
        const missed = missedJobs(jobs, ctx);
        if (missed.length) {
            console.log(
                "⏪ Startup catch-up — today's slot has already passed for: " +
                    missed.map(({ job, slot }) => `${job.name} (${formatSlotTime(slot)})`).join(", ")
            );
            enqueue(missed.map(({ job }) => job), { ...ctx, catchUp: true });
        } else {
            console.log("⏪ Startup catch-up: no slots have passed yet today.");
        }
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

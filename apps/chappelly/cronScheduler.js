import cron from "node-cron";

/**
 * One cron per fire time, not one cron per job — the same scheduler familygo
 * uses (apps/familygo/cronScheduler.js), kept as chappelly's own copy since
 * the apps share no runtime.
 *
 * Every job declares the discrete minutes it wants to run at (its "slots"),
 * and this module:
 *   1. expands every job's slots for the current env,
 *   2. buckets them by slot, so a slot knows every job that wants that minute,
 *   3. registers one cron task per distinct fire time, running that slot's jobs
 *      one after another.
 *
 * Every task shares a single serial queue, so a job that runs long can never
 * overlap the next slot's work either. Recompute and re-register the whole set
 * whenever the env changes (see `startScheduler`).
 *
 * Every task is pinned to America/New_York, and node-cron resolves that zone
 * with its DST rules: a 06:00 slot fires at 6am Eastern year-round, whether
 * that is EST or EDT. Nothing here needs to shift by an hour in March/November.
 */

const TIMEZONE = "America/New_York";
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

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

/**
 * Compile a set of slots into the fewest cron expressions that fire on exactly
 * those minutes: days that fire at identical times share one expression, and
 * within them each minute-of-hour collapses its hours into one hour list.
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
 * Resolve job definitions against the current env into the cron tasks to
 * register: `[{ expression, jobs }]`, where every expression fires on a set of
 * minutes no other expression in the list fires on.
 *
 * Each job is `{ name, slots(ctx) -> slot[], run(ctx) }`. Within a slot, jobs
 * run in the order they appear in `jobs`. A job whose `slots()` throws (a
 * malformed cron written by a direct env edit, say) is logged and left out so
 * it can't take the rest of the schedule down with it.
 */
export const buildSchedule = (jobs, ctx) => {
    const bySlot = new Map(); // slotKey -> { slot, jobs }
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

    // Slots wanting the same jobs can share expressions, which is what keeps the
    // task count near the number of interesting times rather than of minutes.
    const byJobSet = new Map(); // job-name signature -> { jobs, slots }
    for (const { slot, jobs: slotJobs } of bySlot.values()) {
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
 * Register the resolved schedule. Returns a handle whose `stop()` tears every
 * task down again, so an env change can rebuild the whole set:
 *
 *   scheduler?.stop();
 *   scheduler = startScheduler(buildJobs(env), { client, env });
 */
export const startScheduler = (jobs, ctx) => {
    const schedule = buildSchedule(jobs, ctx);

    // Shared across every task: two slots can't run at once, and a job that
    // overruns its slot delays the next one instead of racing it.
    let queue = Promise.resolve();

    const tasks = schedule.map(({ expression, jobs: slotJobs }) =>
        cron.schedule(
            expression,
            () => {
                queue = queue.then(async () => {
                    for (const job of slotJobs) {
                        try {
                            await job.run(ctx);
                        } catch (err) {
                            console.error(`💥 Cron job "${job.name}" failed:`, err);
                        }
                    }
                });
            },
            { timezone: TIMEZONE }
        )
    );

    console.log(`⏰ [chappelly] Scheduled ${tasks.length} cron task(s) across ${jobs.length} job(s) (${TIMEZONE}):`);
    for (const { expression, jobs: slotJobs } of schedule) {
        console.log(`   ${expression.padEnd(30)} → ${slotJobs.map(job => job.name).join(", ")}`);
    }

    return {
        schedule,
        stop() {
            for (const task of tasks) task.stop();
        },
    };
};

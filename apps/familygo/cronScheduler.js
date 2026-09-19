import cron from "node-cron";

/**
 * One cron per fire time, not one cron per job.
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
 *   3. registers one cron task per distinct fire time, running that slot's jobs
 *      one after another.
 *
 * On top of that, every task shares a single serial queue, so a job that runs
 * long can never overlap the next slot's work either. Recompute and re-register
 * the whole set whenever the config changes (see `startScheduler`).
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
 * Resolve job definitions against the current config into the cron tasks to
 * register: `[{ expression, jobs }]`, where every expression fires on a set of
 * minutes no other expression in the list fires on.
 *
 * Each job is `{ name, slots(ctx) -> slot[], run(ctx) }`. Within a slot, jobs
 * run in the order they appear in `jobs`.
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
 * task down again, so a config change can rebuild the whole set:
 *
 *   scheduler?.stop();
 *   scheduler = startScheduler(JOBS, { client, db });
 */
export const startScheduler = (jobs, ctx) => {
    const schedule = buildSchedule(jobs, ctx);

    // Shared across every task: two slots can't run at once, and a job that
    // overruns its slot delays the next one instead of racing it for a browser.
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

    console.log(`⏰ Scheduled ${tasks.length} cron task(s) across ${jobs.length} job(s) (${TIMEZONE}):`);
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

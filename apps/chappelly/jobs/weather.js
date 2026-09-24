import { EmbedBuilder } from "discord.js";
import { recordCronRun } from "../env.js";
import { prepareRun, resolveChannel, resolveMentions, mentionLine } from "./common.js";
import {
  resolveLocation,
  getForecast,
  describeCode,
  unitsFor,
  formatLocalTime,
  formatLocalHour,
} from "../weather.js";

/**
 * The "weather" cron (`job: "weather"` on an env.crons entry): post today's
 * forecast as an embed. Everything else about the entry works exactly as it
 * does for a reminder — times, days, channel, mentions, `everyDays` — so a
 * 7am daily forecast is just another row in the env, editable with /cron.
 *
 * The place comes from `cron.location`, falling back to the env-wide
 * WEATHER_LOCATION, so one household setting covers every weather cron while a
 * single cron can still point somewhere else (a trip, a relative's town).
 *
 * Unlike a reminder this never carries a button: there is nothing to confirm.
 */

const EMBED_COLOR = 0x4a90d9;
// Hours worth showing in the "Later today" strip; past ones are dropped, so a
// 7am post shows all four and a manual 6pm run shows only what is left.
const STRIP_HOURS = [9, 12, 15, 18, 21];

const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);
const temp = (n, units) => (round(n) === null ? "—" : `${round(n)}°${units.tempSymbol}`);

/**
 * Build the forecast embed. Split out from the posting so it stays a pure
 * function of the API payload — the shape of the post can be eyeballed with
 * `/cron run` without waiting for 7am.
 */
export function buildWeatherEmbed(place, forecast, units, { nowHour } = {}) {
  const { current = {}, daily = {}, hourly = {} } = forecast;
  const today = describeCode(daily.weather_code?.[0], true);
  const now = describeCode(current.weather_code, current.is_day !== 0);

  const high = temp(daily.temperature_2m_max?.[0], units);
  const low = temp(daily.temperature_2m_min?.[0], units);
  const rainChance = round(daily.precipitation_probability_max?.[0]);
  const rainTotal = daily.precipitation_sum?.[0];
  const windMax = round(daily.wind_speed_10m_max?.[0]);
  const humidity = round(current.relative_humidity_2m);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`${today.emoji}  ${place.label}`)
    .setDescription(
      [
        `**${temp(current.temperature_2m, units)}** right now — ${now.label.toLowerCase()}`,
        `Feels like ${temp(current.apparent_temperature, units)}${humidity === null ? "" : ` · ${humidity}% humidity`}`,
      ].join("\n"),
    )
    .addFields(
      { name: "Today", value: `${today.label}\n${high} / ${low}`, inline: true },
      {
        name: "Rain",
        value: `${rainChance === null ? "—" : `${rainChance}% chance`}${
          // A trace amount rounds to 0.00 and isn't worth a line of its own.
          Number.isFinite(rainTotal) && rainTotal >= 0.01 ? `\n${rainTotal.toFixed(2)} ${units.precipLabel}` : ""
        }`,
        inline: true,
      },
      { name: "Wind", value: windMax === null ? "—" : `up to ${windMax} ${units.windLabel}`, inline: true },
    );

  // Hourly rows are padded into a code block so the columns line up; Discord's
  // proportional font turns plain-text columns into a ragged mess otherwise.
  const times = hourly.time ?? [];
  const rows = STRIP_HOURS
    .filter((hour) => !Number.isFinite(nowHour) || hour > nowHour)
    .map((hour) => times.findIndex((t) => t.endsWith(`T${String(hour).padStart(2, "0")}:00`)))
    .filter((i) => i >= 0)
    .map((i) => {
      const { emoji } = describeCode(hourly.weather_code?.[i], hourly.is_day?.[i] !== 0);
      const chance = round(hourly.precipitation_probability?.[i]);
      const cells = [
        formatLocalHour(times[i]).padStart(5),
        temp(hourly.temperature_2m?.[i], units).padStart(5),
        `${emoji}${chance ? ` ${chance}%` : ""}`,
      ];
      return cells.join("  ");
    });
  if (rows.length) embed.addFields({ name: "Later today", value: "```\n" + rows.join("\n") + "\n```" });

  embed.addFields({
    name: "Sun",
    value: `🌅 ${formatLocalTime(daily.sunrise?.[0])}  ·  🌇 ${formatLocalTime(daily.sunset?.[0])}`,
  });

  return embed.setFooter({ text: "Open-Meteo" }).setTimestamp(new Date());
}

/**
 * Post the forecast for cron `id`.
 *
 * A failed fetch throws so the scheduler logs it and the next day's slot tries
 * again — there is nothing useful to post instead, and an embed reading "—"
 * everywhere would look like real data.
 *
 * `force` (the manual /cron run) bypasses the interval gate and does not stamp
 * lastRun, matching runReminder.
 * @returns {Promise<import('discord.js').Message|null>} the posted message, or null if skipped
 */
export async function runWeather({ client }, id, { force = false } = {}) {
  const prepared = prepareRun(id, { force });
  if (!prepared) return null;
  const { env, cron, today, everyDays } = prepared;

  const channel = await resolveChannel(client, env, cron, id);
  if (!channel) return null;

  const place = await resolveLocation(cron.location || env.WEATHER_LOCATION);
  const units = unitsFor(cron.units || env.WEATHER_UNITS);
  const forecast = await getForecast(place, units);

  const content = [mentionLine(resolveMentions(env, cron)), String(cron.message ?? "").trim()]
    .filter(Boolean)
    .join(" ");
  // hour12:false renders midnight as "24" on some ICU builds, which would hide
  // the whole "Later today" strip on a run just after midnight.
  const nowHour = Number(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false })) % 24;

  const message = await channel.send({
    content: content || undefined,
    embeds: [buildWeatherEmbed(place, forecast, units, { nowHour })],
  });
  console.log(`🌤️ [chappelly] Posted weather "${id}" for ${place.label} to #${channel.name ?? channel.id}`);
  if (everyDays && !force) await recordCronRun(client, id, today);
  return message;
}

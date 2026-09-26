/**
 * Open-Meteo client for the weather cron (jobs/weather.js).
 *
 * Open-Meteo is the provider because it needs no API key: chappelly keeps only
 * its token in .env and every other setting in the Discord-hosted env (env.js),
 * so a provider with a secret would mean a new .env var — and a redeploy to
 * change it — for a bot whose whole point is being configurable from Discord.
 *
 * Nothing here touches Discord; it's a pure fetch layer over two endpoints:
 * geocoding (a typed place name → coordinates) and the forecast itself.
 */

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const TIMEZONE = "America/New_York";
const REQUEST_TIMEOUT_MS = 10_000;

/** "38.5,-77.2" — coordinates typed straight into WEATHER_LOCATION. */
const COORDS_PATTERN = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/**
 * WMO weather interpretation codes → label and emoji. Codes 0 and 1 carry a
 * night variant because "Clear ☀️" under a 9pm hourly row reads wrong.
 */
const WEATHER_CODES = new Map([
  [0, { label: "Clear", emoji: "☀️", night: "🌙" }],
  [1, { label: "Mostly clear", emoji: "🌤️", night: "🌙" }],
  [2, { label: "Partly cloudy", emoji: "⛅", night: "☁️" }],
  [3, { label: "Overcast", emoji: "☁️" }],
  [45, { label: "Fog", emoji: "🌫️" }],
  [48, { label: "Freezing fog", emoji: "🌫️" }],
  [51, { label: "Light drizzle", emoji: "🌦️" }],
  [53, { label: "Drizzle", emoji: "🌦️" }],
  [55, { label: "Heavy drizzle", emoji: "🌧️" }],
  [56, { label: "Freezing drizzle", emoji: "🌧️" }],
  [57, { label: "Freezing drizzle", emoji: "🌧️" }],
  [61, { label: "Light rain", emoji: "🌦️" }],
  [63, { label: "Rain", emoji: "🌧️" }],
  [65, { label: "Heavy rain", emoji: "🌧️" }],
  [66, { label: "Freezing rain", emoji: "🧊" }],
  [67, { label: "Freezing rain", emoji: "🧊" }],
  [71, { label: "Light snow", emoji: "🌨️" }],
  [73, { label: "Snow", emoji: "🌨️" }],
  [75, { label: "Heavy snow", emoji: "❄️" }],
  [77, { label: "Snow grains", emoji: "🌨️" }],
  [80, { label: "Light showers", emoji: "🌦️" }],
  [81, { label: "Showers", emoji: "🌧️" }],
  [82, { label: "Heavy showers", emoji: "⛈️" }],
  [85, { label: "Snow showers", emoji: "🌨️" }],
  [86, { label: "Heavy snow showers", emoji: "❄️" }],
  [95, { label: "Thunderstorms", emoji: "⛈️" }],
  [96, { label: "Thunderstorms with hail", emoji: "⛈️" }],
  [99, { label: "Thunderstorms with hail", emoji: "⛈️" }],
]);

/** @returns {{ label: string, emoji: string }} */
export function describeCode(code, isDay = true) {
  const entry = WEATHER_CODES.get(Number(code));
  if (!entry) return { label: "—", emoji: "🌡️" };
  return { label: entry.label, emoji: !isDay && entry.night ? entry.night : entry.emoji };
}

export const UNIT_SETS = {
  imperial: { temperature: "fahrenheit", wind: "mph", precipitation: "inch", tempSymbol: "F", windLabel: "mph", precipLabel: "in" },
  metric: { temperature: "celsius", wind: "kmh", precipitation: "mm", tempSymbol: "C", windLabel: "km/h", precipLabel: "mm" },
};

export const unitsFor = (name) => UNIT_SETS[String(name).trim().toLowerCase()] ?? UNIT_SETS.imperial;

/**
 * Retry budget for one request. Open-Meteo answers the occasional 503, and the
 * weather cron gets exactly one shot a day at its slot — without this, a blip
 * at that moment was the day's forecast gone (jobs/weather.js throws rather
 * than post something made up, and the next attempt is tomorrow's). Three
 * tries half a minute apart outlast a momentary outage and still finish well
 * inside the slot, so the reminder sharing it isn't held up.
 */
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch and parse JSON, retrying what might come right on its own: a 5xx or
 * 429, a timeout, a dropped connection, a body that isn't JSON (a gateway's
 * error page). Any other HTTP status is the request being wrong, and is thrown
 * at once — a 404 won't improve in thirty seconds.
 */
async function getJson(url) {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) {
        const err = new Error(`${host} answered HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      // No status means the request never got an answer (network, timeout) or
      // the answer wasn't JSON — both as transient as a 5xx.
      const transient = err.status === undefined || err.status === 429 || err.status >= 500;
      if (!transient || attempt >= RETRY_ATTEMPTS) throw err;
      const reason = err.status === undefined ? err.message : `HTTP ${err.status}`;
      console.warn(
        `⚠️ [chappelly] ${host}: ${reason} — retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt} of ${RETRY_ATTEMPTS})`
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Postal abbreviations → the admin1 names Open-Meteo actually returns. People
 * type "Abingdon, MD"; the geocoder answers `admin1: "Maryland"`, so without
 * this the hint matches nothing and the first (largest) result wins — which is
 * how "Abingdon, MD" used to resolve to Abingdon, Virginia.
 */
const REGION_ALIASES = new Map(Object.entries({
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california",
  co: "colorado", ct: "connecticut", de: "delaware", dc: "district of columbia",
  fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois",
  in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
  me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan",
  mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana",
  ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey",
  nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota",
  oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", pr: "puerto rico",
  ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee",
  tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington",
  wv: "west virginia", wi: "wisconsin", wy: "wyoming",
  ab: "alberta", bc: "british columbia", mb: "manitoba", nb: "new brunswick",
  nl: "newfoundland and labrador", ns: "nova scotia", on: "ontario",
  pe: "prince edward island", qc: "quebec", sk: "saskatchewan",
  usa: "united states", us: "united states", uk: "united kingdom",
}));

/** Lowercase, drop punctuation, collapse whitespace: "St. Mary's Co." → "st marys co". */
const normalize = (value) =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Does a geocoder result sit in the region the user typed after the comma?
 * Compares the hint — and its expanded form, if it's a known abbreviation —
 * against every region field on the result, both as typed and expanded.
 */
function matchesHint(result, hint) {
  const wanted = new Set([hint, REGION_ALIASES.get(hint)].filter(Boolean));
  return [result.admin1, result.admin2, result.country, result.country_code].some((field) => {
    const value = normalize(field);
    if (!value) return false;
    // Open-Meteo is inconsistent about the suffix — "Harford County" but plain
    // "Knox" — so a typed "Harford" has to match either spelling.
    const trimmed = value.replace(/ (county|parish|borough|municipality)$/, "");
    return wanted.has(value) || wanted.has(trimmed) || wanted.has(REGION_ALIASES.get(value));
  });
}

// A place name resolves to the same coordinates forever, and the schedule
// rebuilds (not the process) on every env edit, so one lookup per process per
// distinct location is plenty.
const geocodeCache = new Map();

/**
 * Turn a WEATHER_LOCATION value into coordinates. Accepts "lat,lon" directly —
 * which is also the escape hatch when the geocoder can't find a small town —
 * and otherwise looks the name up.
 * @param {string} query e.g. "Rock Hill, SC" or "34.92,-81.02"
 * @returns {Promise<{ latitude: number, longitude: number, label: string }>}
 */
export async function resolveLocation(query) {
  const raw = String(query ?? "").trim();
  if (!raw) throw new Error("No location set — `/env set WEATHER_LOCATION <city>`.");

  const coords = COORDS_PATTERN.exec(raw);
  if (coords) {
    const latitude = Number(coords[1]);
    const longitude = Number(coords[2]);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new Error(`"${raw}" isn't a valid latitude,longitude pair.`);
    }
    return { latitude, longitude, label: `${latitude}, ${longitude}` };
  }

  const key = raw.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  // The geocoder matches on the place name alone, so a typed "City, ST" has to
  // be split: the name is searched and the rest is used to pick among matches.
  const [name, ...rest] = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
  const results = (await getJson(url)).results ?? [];
  if (results.length === 0) throw new Error(`Couldn't find a place called "${raw}".`);

  const hint = normalize(rest.join(" "));
  let match = results[0];
  if (hint) {
    // Falling back to results[0] on an unmatched hint is how "Abingdon, MD"
    // quietly became Abingdon, VA — if the user named a region, a wrong one is
    // worse than no forecast, so say which places were actually found.
    match = results.find((r) => matchesHint(r, hint));
    if (!match) {
      const found = results.map((r) => [r.name, r.admin1, r.country_code].filter(Boolean).join(", "));
      throw new Error(`Couldn't find "${raw}". Open-Meteo knows: ${found.join(" · ")}.`);
    }
  }

  const place = {
    latitude: match.latitude,
    longitude: match.longitude,
    label: [match.name, match.admin1, match.country_code].filter(Boolean).join(", "),
  };
  geocodeCache.set(key, place);
  return place;
}

/**
 * Today's forecast for a resolved place, in `units` (see UNIT_SETS). Times come
 * back as local "YYYY-MM-DDTHH:mm" strings in America/New_York — the same zone
 * the scheduler fires in — so nothing needs converting before display.
 * @returns {Promise<{ current: object, daily: object, hourly: object }>}
 */
export async function getForecast({ latitude, longitude }, units = UNIT_SETS.imperial) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset",
    hourly: "temperature_2m,weather_code,precipitation_probability,is_day",
    timezone: TIMEZONE,
    forecast_days: "1",
    temperature_unit: units.temperature,
    wind_speed_unit: units.wind,
    precipitation_unit: units.precipitation,
  });

  const data = await getJson(`${FORECAST_URL}?${params}`);
  if (!data?.daily?.time?.length) throw new Error("Open-Meteo returned no daily forecast.");
  return data;
}

/** "2026-09-23T07:12" → "7:12 AM". Returns "—" for anything unparseable. */
export function formatLocalTime(stamp) {
  const match = /T(\d{2}):(\d{2})/.exec(String(stamp ?? ""));
  if (!match) return "—";
  const hour = Number(match[1]);
  const suffix = hour < 12 ? "AM" : "PM";
  return `${((hour + 11) % 12) + 1}:${match[2]} ${suffix}`;
}

/** "2026-09-23T15:00" → "3 PM". */
export function formatLocalHour(stamp) {
  const match = /T(\d{2}):/.exec(String(stamp ?? ""));
  if (!match) return "—";
  const hour = Number(match[1]);
  return `${((hour + 11) % 12) + 1} ${hour < 12 ? "AM" : "PM"}`;
}

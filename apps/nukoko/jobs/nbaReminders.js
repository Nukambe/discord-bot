import { toEstDateString, toEstTimeParts } from '../../../util/dateUtils.js';

// chappelly's NBA streams cron without the stream links: the day's slate at
// 10:00 ET, then a post as each game tips off. With no links to find, the
// schedule comes straight from ESPN's public scoreboard API (no key) rather
// than methstreams, which 403s from the dyno anyway.

const CHANNEL_ID = '1468093888643203243';
const SLATE_HOUR = 10;
const TICK_MS = 60_000;
const RETRY_MS = 10 * 60_000;
// A game whose start is further back than this when first seen (a boot
// mid-evening) is skipped rather than announced late.
const LATE_GRACE_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const SKIP_STATUSES = new Set(['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_SUSPENDED']);
const EMBED_COLOR = 0x1d428a;

// { date, games, announced: Set<id> } for the ET day the games were fetched on.
let day = null;
let retryAt = 0;
let ticking = false;

// A Discord timestamp, so each viewer sees the start in their own timezone.
const timeLabel = (game) => game.timeValid ? `<t:${Math.floor(game.start / 1000)}:t>` : 'TBD';

const prettyDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
  timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
});

const slateTitle = (date) => `🏀 NBA games — ${prettyDate(date)}`;

async function fetchGames(date) {
  const res = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date.replaceAll('-', '')}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const { events = [] } = await res.json();

  return events
    .filter(event => !SKIP_STATUSES.has(event?.status?.type?.name))
    .map(event => {
      const competition = event.competitions?.[0] ?? {};
      const side = (homeAway) => competition.competitors?.find(c => c.homeAway === homeAway)?.team?.displayName;
      const [away, home] = [side('away'), side('home')];
      return {
        id: event.id,
        title: away && home ? `${away} vs ${home}` : String(event.name ?? '').replace(' at ', ' vs '),
        start: new Date(event.date).getTime(),
        // ESPN parks an unannounced tip at a placeholder time and says so here.
        timeValid: competition.timeValid !== false,
        tv: (competition.broadcasts ?? [])
          .filter(b => b.market === 'national')
          .flatMap(b => b.names ?? []),
      };
    })
    .sort((a, b) => a.start - b.start);
}

function buildSlateEmbed(date, games) {
  const lines = games.map(game =>
    `**${timeLabel(game)}** — ${game.title}${game.tv.length ? ` · ${game.tv.join(', ')}` : ''}`,
  );
  return {
    color: EMBED_COLOR,
    title: slateTitle(date),
    description: lines.join('\n'),
    footer: { text: 'Schedule via ESPN' },
  };
}

async function fetchChannel(discordClient) {
  return discordClient.channels.cache.get(CHANNEL_ID)
    ?? await discordClient.channels.fetch(CHANNEL_ID).catch(() => null);
}

// Discord answers "already posted?", so a restart after 10:00 doesn't repost.
async function slatePosted(ch, date) {
  const messages = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  const title = slateTitle(date);
  return !!messages?.some(msg => msg.author.id === ch.client.user.id && msg.embeds.some(e => e.title === title));
}

async function startDay(discordClient, date) {
  const games = await fetchGames(date);
  day = { date, games, announced: new Set() };
  console.log(`🏀 NBA reminders: ${games.length} game(s) on ${date}`);
  if (!games.length) return;

  const ch = await fetchChannel(discordClient);
  if (!ch) return console.error('NBA reminders channel not found:', CHANNEL_ID);
  if (await slatePosted(ch, date)) return;
  await ch.send({ embeds: [buildSlateEmbed(date, games)] });
}

async function announceStarts(discordClient) {
  const now = Date.now();
  const due = day.games.filter(game => game.timeValid && game.start <= now && !day.announced.has(game.id));
  if (!due.length) return;
  const ch = await fetchChannel(discordClient);
  for (const game of due) {
    day.announced.add(game.id);
    if (now - game.start > LATE_GRACE_MS) continue;
    const tv = game.tv.length ? ` (${game.tv.join(', ')})` : '';
    await ch?.send(`🏀 **${game.title}** is starting!${tv}`).catch(console.error);
    console.log(`🏀 NBA reminders: posted start of ${game.title}`);
  }
}

async function tick(discordClient) {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const today = toEstDateString(now);
    if (day?.date !== today && toEstTimeParts(now).hour >= SLATE_HOUR && Date.now() >= retryAt) {
      try {
        await startDay(discordClient, today);
      } catch (err) {
        retryAt = Date.now() + RETRY_MS;
        console.error('NBA reminders: schedule fetch failed, retrying in 10 min:', err.message);
      }
    }
    if (day?.date === today) await announceStarts(discordClient);
  } finally {
    ticking = false;
  }
}

export function startNbaReminders(discordClient) {
  tick(discordClient).catch(console.error);
  setInterval(() => tick(discordClient).catch(console.error), TICK_MS);
  console.log(`NBA reminders scheduled: slate at ${SLATE_HOUR}:00 ET, a post as each game starts`);
}

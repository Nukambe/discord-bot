import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, GuildScheduledEventStatus } from 'discord.js';
import { toEstDateString, toEstTimeParts } from '../../../util/dateUtils.js';

// chappelly's NBA streams cron without the stream links: the day's slate at
// 10:00 ET, plus a Discord scheduled event per game. The bot starts each event
// at tip-off (which notifies everyone marked Interested), keeps its description
// a live box line through the game, and ends it a while after the final. The
// schedule and live stats come straight from ESPN's public scoreboard API (no
// key) rather than methstreams, which 403s from the dyno anyway.
//
// The events themselves are the state: a restart finds the bot's own events
// and picks up where it left off, matching each to its ESPN game by name and
// ET date, so nothing is kept in memory but the date the slate went out.

const CHANNEL_ID = '1468093888643203243';
const SLATE_HOUR = 10;
const TICK_MS = 60_000;
const RETRY_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
// External events need an end time; Discord ends them there on its own, so the
// guess is generous and a live game pushes it out further as it nears.
const GAME_LENGTH_MS = 3.5 * 60 * 60_000;
const EXTEND_WITHIN_MS = 30 * 60_000;
const EXTEND_BY_MS = 60 * 60_000;
// An ended event vanishes from the server's list at once, so a finished game
// stays up this long with its final score before the bot ends it.
const FINAL_LINGER_MS = 60 * 60_000;
const SKIP_STATUSES = new Set(['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_SUSPENDED']);
const LEADER_STATS = [['points', 'PTS'], ['rebounds', 'REB'], ['assists', 'AST']];
const EMBED_COLOR = 0x1d428a;

// The ET date the slate was last handled for.
let slateDate = null;
let retryAt = 0;
let ticking = false;

// A Discord timestamp, so each viewer sees the start in their own timezone.
const timeLabel = (game) => game.timeValid ? `<t:${Math.floor(game.start / 1000)}:t>` : 'TBD';

const prettyDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
  timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
});

const slateTitle = (date) => `🏀 NBA games — ${prettyDate(date)}`;

// Discord caps event names at 100 characters; the name is also the match key.
const eventName = (game) => game.title.slice(0, 100);

const teamInfo = (competitor) => ({
  abbr: competitor?.team?.abbreviation ?? '',
  name: competitor?.team?.displayName ?? '',
  score: competitor?.score ?? '0',
  record: competitor?.records?.find(r => r.type === 'total')?.summary ?? null,
  periods: (competitor?.linescores ?? []).map(l => l.displayValue ?? String(l.value ?? '')),
  leaders: Object.fromEntries((competitor?.leaders ?? []).map(l => [l.name, l.leaders?.[0]])),
});

async function fetchGames(date) {
  const res = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date.replaceAll('-', '')}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const { events = [] } = await res.json();

  return events
    .map(event => {
      const competition = event.competitions?.[0] ?? {};
      const side = (homeAway) => competition.competitors?.find(c => c.homeAway === homeAway);
      const [away, home] = [teamInfo(side('away')), teamInfo(side('home'))];
      return {
        id: event.id,
        title: away.name && home.name ? `${away.name} vs ${home.name}` : String(event.name ?? '').replace(' at ', ' vs '),
        start: new Date(event.date).getTime(),
        // ESPN parks an unannounced tip at a placeholder time and says so here.
        timeValid: competition.timeValid !== false,
        tv: (competition.broadcasts ?? [])
          .filter(b => b.market === 'national')
          .flatMap(b => b.names ?? []),
        venue: competition.venue?.fullName ?? null,
        statusName: event.status?.type?.name,
        state: event.status?.type?.state, // 'pre' | 'in' | 'post'
        detail: event.status?.type?.shortDetail ?? '', // "Q3 8:42", "Halftime", "Final/OT"
        away,
        home,
      };
    })
    .sort((a, b) => a.start - b.start);
}

function buildSlateEmbed(date, games, eventUrls) {
  const lines = games.map(game => {
    const url = eventUrls.get(eventName(game));
    const title = url ? `[${game.title}](${url})` : game.title;
    return `**${timeLabel(game)}** — ${title}${game.tv.length ? ` · ${game.tv.join(', ')}` : ''}`;
  });
  return {
    color: EMBED_COLOR,
    title: slateTitle(date),
    description: lines.join('\n'),
    footer: { text: 'Schedule via ESPN' },
  };
}

// Points per quarter (and OT) in a monospace block.
function lineScore(away, home) {
  const periods = Math.max(away.periods.length, home.periods.length);
  if (!periods) return null;
  const label = (i) => i < 4 ? String(i + 1) : i === 4 ? 'OT' : `${i - 3}OT`;
  const indexes = [...Array(periods).keys()];
  const width = Math.max(away.abbr.length, home.abbr.length);
  const row = (head, cells) => `${head.padEnd(width)} ${cells.map(c => String(c).padStart(3)).join(' ')}`;
  return [
    '```',
    row('', [...indexes.map(label), 'T']),
    row(away.abbr, [...indexes.map(i => away.periods[i] ?? '-'), away.score]),
    row(home.abbr, [...indexes.map(i => home.periods[i] ?? '-'), home.score]),
    '```',
  ].join('\n');
}

function leaderLine(team) {
  const parts = LEADER_STATS.flatMap(([key, label]) => {
    const leader = team.leaders[key];
    return leader?.athlete ? [`${leader.athlete.shortName} ${leader.displayValue} ${label}`] : [];
  });
  return parts.length ? `**${team.abbr}** — ${parts.join(' · ')}` : null;
}

function eventDescription(game) {
  const { away, home } = game;
  const tv = game.tv.length ? `📺 ${game.tv.join(', ')}` : null;
  const lines = game.state === 'pre'
    ? [
      `**${away.name}**${away.record ? ` (${away.record})` : ''} at **${home.name}**${home.record ? ` (${home.record})` : ''}`,
      tv,
      'Live score and stats show up here once the game tips off.',
    ]
    : [
      `**${away.abbr} ${away.score} – ${home.abbr} ${home.score}** · ${game.detail}`,
      lineScore(away, home),
      leaderLine(away),
      leaderLine(home),
      tv,
    ];
  // Discord caps event descriptions at 1000 characters.
  return lines.filter(Boolean).join('\n').trim().slice(0, 1000);
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

// The bot's own events, which are all NBA games. Ended events aren't listed.
async function botEvents(guild) {
  const events = await guild.scheduledEvents.fetch();
  return events.filter(event => event.creatorId === guild.client.user.id);
}

// One event per game still ahead, skipping any a previous run already made.
// Returns name -> event URL for every game that has one, for the slate.
async function createEvents(guild, date, games) {
  const urls = new Map();
  for (const event of (await botEvents(guild)).values()) {
    if (toEstDateString(event.scheduledStartAt) === date) urls.set(event.name, event.url);
  }
  // Discord only takes an event that starts in the future.
  const earliest = Date.now() + 60_000;
  for (const game of games) {
    const name = eventName(game);
    if (urls.has(name) || !game.timeValid || game.start < earliest) continue;
    try {
      const event = await guild.scheduledEvents.create({
        name,
        scheduledStartTime: game.start,
        scheduledEndTime: game.start + GAME_LENGTH_MS,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: [game.venue, ...game.tv].filter(Boolean).join(' · ').slice(0, 100) || 'NBA' },
        description: eventDescription(game),
      });
      urls.set(name, event.url);
      console.log(`🏀 NBA events: created ${name}`);
    } catch (err) {
      console.error(`NBA events: couldn't create ${name}:`, err.message);
    }
  }
  return urls;
}

async function startDay(discordClient, date) {
  const games = (await fetchGames(date)).filter(game => !SKIP_STATUSES.has(game.statusName));
  slateDate = date;
  console.log(`🏀 NBA reminders: ${games.length} game(s) on ${date}`);
  if (!games.length) return;

  const ch = await fetchChannel(discordClient);
  if (!ch) return console.error('NBA reminders channel not found:', CHANNEL_ID);
  const eventUrls = await createEvents(ch.guild, date, games).catch(err => {
    console.error('NBA events: creating events failed:', err.message);
    return new Map();
  });
  if (await slatePosted(ch, date)) return;
  await ch.send({ embeds: [buildSlateEmbed(date, games, eventUrls)] });
}

// Scheduled -> Active at tip-off, live description through the game, then
// final score for FINAL_LINGER_MS and Completed.
async function syncEvent(event, game, now) {
  if (SKIP_STATUSES.has(game.statusName)) {
    await event.setStatus(event.isScheduled() ? GuildScheduledEventStatus.Canceled : GuildScheduledEventStatus.Completed);
    return console.log(`🏀 NBA events: ${event.name} ${game.statusName}, ended its event`);
  }
  // The listed start is a few minutes ahead of the actual tip.
  if (game.state === 'pre') return;
  if (event.isScheduled()) {
    event = await event.setStatus(GuildScheduledEventStatus.Active);
    console.log(`🏀 NBA events: ${event.name} tipped off`);
  }

  const description = eventDescription(game);
  if (game.state === 'in') {
    if (description !== event.description) await event.edit({ description });
    if (event.scheduledEndTimestamp < now + EXTEND_WITHIN_MS) {
      await event.edit({ scheduledEndTime: now + EXTEND_BY_MS })
        .catch(err => console.error(`NBA events: couldn't extend ${event.name}:`, err.message));
    }
  } else if (description !== event.description) {
    await event.edit({ description });
    await event.edit({ scheduledEndTime: now + FINAL_LINGER_MS })
      .catch(err => console.error(`NBA events: couldn't extend ${event.name}:`, err.message));
    console.log(`🏀 NBA events: ${event.name} final`);
  } else if (now >= event.scheduledEndTimestamp) {
    await event.setStatus(GuildScheduledEventStatus.Completed);
  }
}

// Every event that has started or should have, against that day's scoreboard.
// Driven by the events rather than the slate date, so a game running past
// midnight keeps updating.
async function syncEvents(discordClient) {
  const ch = await fetchChannel(discordClient);
  if (!ch) return;
  const now = Date.now();
  const events = (await botEvents(ch.guild))
    .filter(event => event.isActive() || (event.isScheduled() && event.scheduledStartTimestamp <= now));
  if (!events.size) return;

  const scoreboards = new Map();
  for (const event of events.values()) {
    const date = toEstDateString(event.scheduledStartAt);
    if (!scoreboards.has(date)) {
      scoreboards.set(date, await fetchGames(date).catch(err => {
        console.error(`NBA events: scoreboard fetch for ${date} failed:`, err.message);
        return null;
      }));
    }
    const games = scoreboards.get(date);
    if (!games) continue;
    const game = games.find(g => eventName(g) === event.name);
    try {
      if (game) await syncEvent(event, game, now);
      else {
        // Dropped from the schedule — don't leave it waiting forever.
        await event.setStatus(event.isScheduled() ? GuildScheduledEventStatus.Canceled : GuildScheduledEventStatus.Completed);
        console.log(`🏀 NBA events: ${event.name} not on ESPN's ${date} schedule, ended its event`);
      }
    } catch (err) {
      console.error(`NBA events: couldn't update ${event.name}:`, err.message);
    }
  }
}

async function tick(discordClient) {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const today = toEstDateString(now);
    if (slateDate !== today && toEstTimeParts(now).hour >= SLATE_HOUR && Date.now() >= retryAt) {
      try {
        await startDay(discordClient, today);
      } catch (err) {
        retryAt = Date.now() + RETRY_MS;
        console.error('NBA reminders: schedule fetch failed, retrying in 10 min:', err.message);
      }
    }
    await syncEvents(discordClient).catch(err => console.error('NBA events: sync failed:', err.message));
  } finally {
    ticking = false;
  }
}

export function startNbaReminders(discordClient) {
  tick(discordClient).catch(console.error);
  setInterval(() => tick(discordClient).catch(console.error), TICK_MS);
  console.log(`NBA reminders scheduled: slate and game events at ${SLATE_HOUR}:00 ET, live scores every minute`);
}

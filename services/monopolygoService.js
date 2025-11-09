import * as cheerio from 'cheerio';

function formatNyParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: '2-digit', year: 'numeric',
  }).formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
  return {
    mon: (parts.month || '').toLowerCase(),
    day: (parts.day || '').padStart(2, '0'),
    year: parts.year,
  };
}

export function buildTodaysPrefix(date = new Date()) {
  const { mon, day, year } = formatNyParts(date);
  if (!mon || !day || !year) throw new Error('Could not compute slug prefix');
  return `https://monopolygo.wiki/todays-events-${mon}-${day}-${year}`;
}

async function tryGet(url) {
  const res = await fetch(url, { redirect: 'follow' });
  return res.ok ? res : null;
}

// HREF-only matcher
async function findViaTagPages(prefix) {
  const site = 'https://monopolygo.wiki';
  const pages = [
    `${site}/tag/events/`,
  ];

  for (const pageUrl of pages) {
    const res = await fetch(pageUrl);
    if (!res.ok) continue;
    const html = await res.text();
    const $ = cheerio.load(html);

    const match = $('a.gh-card-link')
      .map((_, a) => $(a).attr('href'))
      .get()
      .filter(Boolean)
      .map(href => new URL(href, site).href)
      .find(abs => abs.startsWith(prefix));

    if (match) return match;
  }
  return null;
}

// RSS fallback (href-only via prefix)
async function findViaRss(prefix) {
  const res = await fetch('https://monopolygo.wiki/rss/');
  if (!res.ok) return null;
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  let found = null;
  $('item > link').each((_, el) => {
    const link = $(el).text().trim();
    if (link && link.startsWith(prefix + '/')) {
      found = link;
      return false;
    }
  });
  return found;
}

export async function resolveTodaysUrl(date = new Date()) {
  const prefix = buildTodaysPrefix(date);

  // 1) exact
  const exact = await tryGet(prefix + '/');
  if (exact) return prefix + '/';

  // 2) tag pages (href-only)
  const fromTag = await findViaTagPages(prefix);
  if (fromTag) return fromTag;

  return null;
}

export async function fetchMonopolyGoHtml(url = null, date = new Date()) {
  const finalUrl = url || await resolveTodaysUrl(date);
  const res = await fetch(finalUrl, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${finalUrl}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

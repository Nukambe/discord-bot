import * as cheerio from 'cheerio';

/**
 * Convert Monopoly GO "Today's Events" HTML into a Discord payload.
 * @param {string} html - Raw HTML of the article page.
 * @param {object} [opts]
 * @param {string} [opts.sourceUrl] - Used for absolute URL resolution + embed link/footer.
 * @param {number} [opts.maxFields=12] - Max embed fields (Discord limit-friendly).
 * @param {number} [opts.maxImageEmbeds=4] - Extra image-only embeds (in addition to the main one).
 * @returns {{ content: string, embeds: Array<object> }}
 */
export function parseMonopolyEventPage(html, opts = {}) {
  const { sourceUrl, maxFields = 12, maxImageEmbeds = 4 } = opts;
  const $ = cheerio.load(html);

  const title =
    $('h1.gh-article-title').first().text().trim() ||
    $('title').first().text().trim() ||
    "Monopoly GO — Today's Events";

  // --- Collect article images (exclude the ad with caption) ---
  // We take *all* uncaptioned figures inside article body, in order of appearance.
  const contentImages = $('section.gh-content figure.kg-image-card')
    .toArray()
    .filter(el => !$(el).hasClass('kg-card-hascaption'))
    .map(el => $(el).find('img').attr('src'))
    .filter(Boolean)
    .map(src => resolveUrl(src, sourceUrl));

  // Fallbacks if none matched
  if (contentImages.length === 0) {
    const og = $('meta[property="og:image"]').attr('content');
    const header = $('.gh-article-image img').attr('src');
    if (og || header) contentImages.push(resolveUrl(og || header, sourceUrl));
  }

  // Primary featured image is the first (or last—choose what looks better).
  // Using the first tends to show MLS banner before TN poster if both are present.
  const featuredImage = contentImages[0] || null;
  const extraImages = contentImages.slice(1); // the rest

  // --- Build structured sections: <h4> followed by consecutive .event-block siblings ---
  const sections = [];
  $('section.gh-content h4').each((_, h) => {
    const heading = $(h).text().replace(/\s+/g, ' ').trim();
    if (!heading) return;

    const items = [];
    let $n = $(h).next();

    // Pull in contiguous siblings until the next header
    while ($n.length && !$n.is('h1,h2,h3,h4')) {
      if ($n.is('.event-block')) {
        const line = stringifyEventBlock($n, $);
        if (line) items.push(line);
      }
      $n = $n.next();
    }

    if (items.length) sections.push({ heading, items });
  });

  // Fallback: minimal summary if no sections detected
  if (sections.length === 0) {
    const firstPara = $('section.gh-content p').first().text().trim();
    if (firstPara) sections.push({ heading: 'Summary', items: [firstPara] });
  }

  // --- Plaintext fallback (always included) ---
  const plain = [];
  plain.push(`**${title}**`);
  for (const s of sections) {
    plain.push(`\n__${s.heading}__`);
    for (const it of s.items.slice(0, 15)) plain.push(`• ${it}`);
  }
  if (sourceUrl) plain.push(`\nSource: ${sourceUrl}`);
  const content = trimTo(plain.join('\n'), 1900);

  // --- Main embed (with fields and the first image) ---
  const mainEmbed = {
    title,
    url: sourceUrl || null,
    description: 'Today’s Monopoly GO! highlights:',
    fields: [],
    footer: sourceUrl ? { text: safeHostname(sourceUrl) } : undefined,
    image: featuredImage ? { url: featuredImage } : undefined,
  };

  for (const s of sections) {
    const value = s.items.slice(0, 10).map(x => `• ${x}`).join('\n') || '—';
    mainEmbed.fields.push({
      name: trimTo(s.heading, 256),
      value: trimTo(value, 1024),
      inline: false,
    });
    if (mainEmbed.fields.length >= maxFields) break;
  }

  // Final fallback for unexpected markup
  if (mainEmbed.fields.length === 0) {
    const fallback = $('section.gh-content p')
      .slice(0, 2)
      .map((__, p) => $(p).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean)
      .join('\n\n');
    if (fallback) mainEmbed.description = trimTo(fallback, 2048);
  }

  // --- Extra image-only embeds (to show additional posters) ---
  // Discord allows up to 10 embeds per message. We already use 1 (mainEmbed),
  // so we cap extras to `maxImageEmbeds` (default 4).
  const imageEmbeds = extraImages.slice(0, Math.max(0, maxImageEmbeds)).map(url => ({
    url: sourceUrl || null,
    image: { url },
  }));

  return { content, embeds: [mainEmbed, ...imageEmbeds] };
}

/**
 * Turn one `.event-block` card into a single Discord-friendly line.
 * Handles:
 *  - Event name (bold span or img alt, with safe fallbacks)
 *  - Start/end times from `.local-date` (via data-date UTC timestamp)
 *  - Duration from "Duration:" spans
 *  - Quick Wins rewards from `.reward-item`
 */
function stringifyEventBlock($block, $) {
  // Event name
  let name =
    $block.find('> div:first-child span[style*="font-weight"]').first().text().trim() ||
    $block.find('span[style*="font-weight"]').first().text().trim() ||
    $block.find('img[alt]').first().attr('alt') ||
    'Event';

  // Start/end time(s) – use data-date (UTC timestamp) instead of visible text
  const localDates = $block
    .find('.local-date')
    .map((__, el) => {
      const tsStr = $(el).attr('data-date');
      if (!tsStr) {
        // Fallback to whatever text is there, just in case
        return $(el).text().replace(/\s+/g, ' ').trim();
      }
      const ts = Number(tsStr);
      if (!Number.isFinite(ts)) {
        return $(el).text().replace(/\s+/g, ' ').trim();
      }
      return formatUtcTimestamp(ts);
    })
    .get()
    .filter(Boolean);

  // Duration (text like "Duration: 00:30:00")
  let duration = null;
  $block.find('span').each((__, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (/^Duration:/i.test(t)) {
      duration = t.replace(/^Duration:\s*/i, '');
    }
  });

  // Rewards (Quick Wins)
  const rewards = $block
    .find('.reward-item')
    .map((__, ri) => {
      const qty = $(ri).find('.reward-quantity').text().trim();
      const what = $(ri).find('img[alt]').attr('alt')?.trim() || 'Reward';
      return qty ? `${what} x${qty}` : what;
    })
    .get();

  // Assemble a compact line
  let line = `**${name}**`;

  if (localDates.length >= 2) {
    line += ` — ${localDates[0]} → ${localDates[1]}`;
  } else if (localDates.length === 1) {
    line += ` — ${localDates[0]}`;
  }

  if (duration) line += `  •  Duration: ${duration}`;
  if (rewards.length) line += `  •  ${rewards.join('  |  ')}`;

  return line;
}

// --- helpers ---
function trimTo(str, n) {
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
function resolveUrl(src, baseUrl) {
  try {
    return new URL(src, baseUrl || 'https://monopolygo.wiki').href;
  } catch {
    return src;
  }
}
function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Convert a Unix timestamp in seconds (UTC) into a formatted local string.
 * Example input: 1763398800.0  -> "11/17/2025, 12:00:00 PM" (America/New_York)
 */
function formatUtcTimestamp(seconds) {
  const ms = seconds * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';

  try {
    // Adjust as needed; this matches your 11/17/2025, 12:00:00 PM example for EST.
    return d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  } catch {
    // Fallback: ISO-ish UTC
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  }
}

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
    $('h1').first().text().trim() ||
    $('title').first().text().trim() ||
    "Monopoly GO — Today's Events";

  // --- Collect article images ---
  // Content images live in <figure class="pw-image"> inside the article body.
  const contentImages = $('article.pw-content figure.pw-image img')
    .toArray()
    .map(el => $(el).attr('src'))
    .filter(Boolean)
    .map(src => resolveUrl(src, sourceUrl));

  // Fallbacks if none matched (e.g. the generic daily header banner / og:image)
  if (contentImages.length === 0) {
    const og = $('meta[property="og:image"]').attr('content');
    const header = $('article img').first().attr('src');
    if (og || header) contentImages.push(resolveUrl(og || header, sourceUrl));
  }

  // Primary featured image is the first (or last—choose what looks better).
  const featuredImage = contentImages[0] || null;
  const extraImages = contentImages.slice(1); // the rest

  // --- Build structured sections: <h2> (direct child of article.pw-content) ---
  // followed by sibling wrapper blocks containing .event-block / .quick-win items.
  const sections = [];
  $('article.pw-content > h2').each((_, h) => {
    const heading = $(h).text().replace(/\s+/g, ' ').trim();
    if (!heading) return;

    const items = [];
    let $n = $(h).next();

    // Pull in contiguous siblings until the next header
    while ($n.length && !$n.is('h1,h2,h3')) {
      $n.find('.event-block, .quick-win').each((__, block) => {
        const $block = $(block);
        const line = $block.hasClass('event-block')
          ? stringifyEventBlock($block, $)
          : stringifyQuickWin($block, $);
        if (line) items.push(line);
      });
      $n = $n.next();
    }

    if (items.length) sections.push({ heading, items });
  });

  // Fallback: minimal summary if no sections detected
  if (sections.length === 0) {
    const firstPara = $('article.pw-content > p').first().text().trim();
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
    const fallback = $('article.pw-content > p')
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
 *  - Event name (link text inside .event-block__name, with safe fallbacks)
 *  - Start/end times from `.local-date` (via data-date UTC timestamp)
 *  - Duration from `.event-block__duration`
 */
function stringifyEventBlock($block, $) {
  // Event name
  let name =
    $block.find('.event-block__name a').first().text().trim() ||
    $block.find('.event-block__name').first().text().trim() ||
    $block.find('img[alt]').first().attr('alt') ||
    'Event';

  // For Free Parking events, tag name with [cash] or [dice] based on commodity img src
  if (/free\s*parking/i.test(name)) {
    const commoditySrc = $block.find('.event-block__icon').first().attr('src') || '';
    if (/FreeParking_Money/i.test(commoditySrc)) {
      name += ' [cash]';
    } else if (/LuckyRoll/i.test(commoditySrc)) {
      name += ' [dice]';
    }
  }

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

  // Duration (text like "Duration: 0:45")
  let duration = null;
  const durationText = $block.find('.event-block__duration').first().text().replace(/\s+/g, ' ').trim();
  if (/^Duration:/i.test(durationText)) {
    duration = durationText.replace(/^Duration:\s*/i, '');
  }

  // Rewards (only present on some card variants)
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

/**
 * Turn one `.quick-win` card into a single Discord-friendly line.
 * Handles:
 *  - Task name from `.quick-win__task h3`
 *  - Rewards from `.quick-win__reward` (label + quantity)
 */
function stringifyQuickWin($block, $) {
  const name = $block.find('.quick-win__task h3').first().text().trim() || 'Task';

  const rewards = $block
    .find('.quick-win__reward')
    .map((__, ri) => {
      const what = $(ri).find('.quick-win__reward-label').first().text().trim() || 'Reward';
      const qty = $(ri).find('.quick-win__reward-quantity').first().text().trim();
      return qty ? `${what} x${qty}` : what;
    })
    .get();

  let line = `**${name}**`;
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

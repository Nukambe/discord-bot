import { fetchMonopolyGoHtml } from './services/monopolygoService.js';
import { formatMonopolyGoForDiscord } from './services/monopolygoFormatService.js';

const url = 'https://monopolygo.wiki/todays-events-nov-07-2025/';
const html = await fetchMonopolyGoHtml(url);
const payload = formatMonopolyGoForDiscord(html, { sourceUrl: url });
console.log(payload.content); // or send payload to Discord
console.log("=======================================================================================")
console.log(payload.embeds);

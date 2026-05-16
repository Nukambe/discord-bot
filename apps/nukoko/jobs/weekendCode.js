import cron from 'node-cron';

const CHANNEL_ID = '1468093888643203243';

function buildCode() {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `KBSR${yy}${mm}${dd}`;
}

async function post(discordClient) {
    const code = buildCode();
    const ch = discordClient.channels.cache.get(CHANNEL_ID)
        ?? await discordClient.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!ch) {
        console.error('Weekend code channel not found:', CHANNEL_ID);
        return;
    }
    await ch.send(`Weekend code: **${code}**`).catch(console.error);
    console.log(`Posted weekend code: ${code}`);
}

export function startWeekendCodeJob(discordClient) {
    // Every Saturday at 9:00 AM EST
    cron.schedule('0 9 * * 6', () => {
        post(discordClient).catch(console.error);
    }, { timezone: 'America/New_York' });

    console.log('Weekend code job scheduled: Saturdays at 9:00 AM EST');
}

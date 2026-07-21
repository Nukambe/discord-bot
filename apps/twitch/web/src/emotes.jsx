// Renders a chat message with Twitch's native emotes as inline <img>s,
// using tmi.js's `tags.emotes` shape: { [emoteId]: ["start-end", ...] }.
export function renderMessageWithEmotes(message, emotes) {
  if (!emotes || Object.keys(emotes).length === 0) return message;

  const ranges = [];
  for (const [emoteId, positions] of Object.entries(emotes)) {
    for (const pos of positions) {
      const [start, end] = pos.split('-').map(Number);
      ranges.push({ start, end, emoteId });
    }
  }
  ranges.sort((a, b) => a.start - b.start);

  const nodes = [];
  let cursor = 0;

  for (const r of ranges) {
    if (r.start > cursor) nodes.push(message.slice(cursor, r.start));
    const code = message.slice(r.start, r.end + 1);
    nodes.push(
      <img
        key={`${r.emoteId}-${r.start}`}
        src={`https://static-cdn.jtvnw.net/emoticons/v2/${r.emoteId}/default/dark/2.0`}
        alt={code}
        title={code}
        style={{ height: '1.4em', verticalAlign: 'middle', margin: '0 2px' }}
      />
    );
    cursor = r.end + 1;
  }

  if (cursor < message.length) nodes.push(message.slice(cursor));

  return nodes;
}

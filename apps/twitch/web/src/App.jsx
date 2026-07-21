import { useEffect, useRef, useState } from 'react';
import Panel from './Panel.jsx';
import { twitch, colorForUser } from './theme.js';
import { renderMessageWithEmotes } from './emotes.jsx';

export default function App() {
  const [status, setStatus] = useState({ twitchConnected: false, channel: null });
  const [recent, setRecent] = useState(null);
  const [queue, setQueue] = useState([]);
  const [chat, setChat] = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);
  // Fulfilling is purely a local view concern — the bot keeps re-sending its
  // full queue on every new request, so we just remember which ids to hide.
  const [fulfilledIds, setFulfilledIds] = useState(() => new Set());

  useEffect(() => {
    const source = new EventSource('/events');

    source.addEventListener('status', e => setStatus(JSON.parse(e.data)));
    source.addEventListener('recent', e => setRecent(JSON.parse(e.data)));
    source.addEventListener('character-queue', e => setQueue(JSON.parse(e.data)));
    source.addEventListener('chat', e => setChat(JSON.parse(e.data)));
    source.addEventListener('now-playing', e => setNowPlaying(JSON.parse(e.data)));

    return () => source.close();
  }, []);

  // Ticks the progress bar forward between the ~7s server pushes, without
  // needing any extra network traffic.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!nowPlaying?.playing || !nowPlaying?.isPlaying) return;
    const id = setInterval(() => setTick(t => t + 1), 250);
    return () => clearInterval(id);
  }, [nowPlaying?.playing, nowPlaying?.isPlaying]);

  const estimatedProgressMs = nowPlaying?.isPlaying
    ? Math.min(nowPlaying.progressMs + (Date.now() - nowPlaying.fetchedAt), nowPlaying.durationMs)
    : nowPlaying?.progressMs ?? 0;
  const progressPct = nowPlaying?.durationMs ? (estimatedProgressMs / nowPlaying.durationMs) * 100 : 0;

  function fulfill(id) {
    setFulfilledIds(prev => new Set(prev).add(id));
  }

  const visibleQueue = queue.filter(q => !fulfilledIds.has(q.id));

  const chatEndRef = useRef(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'end' });
  }, [chat]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          fontSize: 11,
          color: twitch.textMuted,
          borderBottom: `1px solid ${twitch.border}`,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: status.twitchConnected ? twitch.purple : twitch.textMuted,
            flexShrink: 0,
          }}
        />
        Twitch: {status.twitchConnected ? `connected (${status.channel})` : 'disconnected'}
      </div>

      <Panel title="Recent">
        {recent ? (
          <div>
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: twitch.purple, fontWeight: 600 }}>!{recent.command}</span>
              {' — '}
              <span style={{ color: twitch.text }}>{recent.requestedBy}</span>
            </div>
            <div style={{ color: twitch.textMuted }}>{recent.response}</div>
          </div>
        ) : (
          <div style={{ color: twitch.textMuted }}>No commands run yet.</div>
        )}
      </Panel>

      <Panel title="Now Playing">
        {nowPlaying?.playing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {nowPlaying.artworkUrl ? (
              <img
                src={nowPlaying.artworkUrl}
                alt=""
                style={{ width: 48, height: 48, borderRadius: 4, flexShrink: 0 }}
              />
            ) : (
              <div style={{ width: 48, height: 48, borderRadius: 4, background: twitch.border, flexShrink: 0 }} />
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  color: twitch.text,
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {nowPlaying.title}
              </div>
              <div
                style={{
                  color: twitch.textMuted,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginBottom: 6,
                }}
              >
                {nowPlaying.artists?.join(', ')}
              </div>
              <div style={{ height: 3, borderRadius: 2, background: twitch.border }}>
                <div
                  style={{
                    height: '100%',
                    borderRadius: 2,
                    background: twitch.purple,
                    width: `${progressPct}%`,
                  }}
                />
              </div>
            </div>
          </div>
        ) : (
          <div style={{ color: twitch.textMuted }}>Nothing playing.</div>
        )}
      </Panel>

      <Panel title={`Character Request Queue${visibleQueue.length ? ` (${visibleQueue.length})` : ''}`}>
        {visibleQueue.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {visibleQueue
              .slice()
              .reverse()
              .map(q => (
                <div
                  key={q.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span style={{ color: twitch.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <strong style={{ color: twitch.purple }}>{q.character}</strong> — {q.requester}
                  </span>
                  <button
                    onClick={() => fulfill(q.id)}
                    style={{
                      background: 'transparent',
                      border: `1px solid ${twitch.purple}`,
                      color: twitch.purple,
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '2px 8px',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    Fulfill
                  </button>
                </div>
              ))}
          </div>
        ) : (
          <div style={{ color: twitch.textMuted }}>No requests yet.</div>
        )}
      </Panel>

      <Panel title="Chat" fill>
        {chat.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {chat.map((c, i) => (
              <div key={c.id ?? i} style={{ opacity: c.self ? 0.7 : 1, color: twitch.text }}>
                <span style={{ color: c.color || colorForUser(c.user), fontWeight: 600 }}>{c.user}</span>:{' '}
                {renderMessageWithEmotes(c.message, c.emotes)}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        ) : (
          <div style={{ color: twitch.textMuted }}>No chat yet.</div>
        )}
      </Panel>
    </div>
  );
}

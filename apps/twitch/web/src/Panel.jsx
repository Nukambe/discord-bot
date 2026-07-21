import { useState } from 'react';
import { twitch } from './theme.js';

export default function Panel({ title, defaultOpen = true, fill = false, children }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      style={{
        borderBottom: `1px solid ${twitch.border}`,
        display: 'flex',
        flexDirection: 'column',
        flex: fill && open ? 1 : '0 0 auto',
        minHeight: 0,
      }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          textAlign: 'left',
          background: twitch.panelBg,
          color: twitch.text,
          border: 'none',
          padding: '10px 12px',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>{title}</span>
        <span
          style={{
            display: 'inline-block',
            color: twitch.purple,
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease',
          }}
        >
          ▶
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: '8px 12px 12px',
            fontSize: 13,
            overflowY: 'auto',
            background: twitch.bg,
            ...(fill ? { flex: 1, minHeight: 0 } : { maxHeight: 300 }),
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

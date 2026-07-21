// Twitch's own dark-theme palette (chat/dashboard), reused so the overlay
// reads as "part of Twitch" rather than a generic dark UI.
export const twitch = {
  bg: '#18181b',
  panelBg: '#1f1f23',
  border: '#343440',
  text: '#efeff1',
  textMuted: '#adadb8',
  purple: '#9146ff',
  purpleHover: '#772ce8',
  live: '#eb0400',
};

// Twitch's legacy default username colors — assigned to chatters who haven't
// picked a custom color. tags.color from IRC is preferred when present.
const DEFAULT_USER_COLORS = [
  '#FF0000', '#0000FF', '#008000', '#B22222', '#FF7F50',
  '#9ACD32', '#FF4500', '#2E8B57', '#DAA520', '#D2691E',
  '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F',
];

export function colorForUser(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return DEFAULT_USER_COLORS[Math.abs(hash) % DEFAULT_USER_COLORS.length];
}

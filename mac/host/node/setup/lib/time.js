// Friendly times: "just now", "5 minutes ago", "yesterday at 14:02", "3 Oct at 09:10".

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Accepts ms since 1970, an ISO string or a Date; NaN when it's none of those.
export function toMs(v) {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && v) return Date.parse(v);
  return NaN;
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export function dayAndTime(at, now = Date.now()) {
  const ms = toMs(at);
  if (Number.isNaN(ms)) return '';
  if (sameDay(ms, now)) return `today at ${clock(ms)}`;
  if (sameDay(ms, now - DAY)) return `yesterday at ${clock(ms)}`;
  const opts = { day: 'numeric', month: 'short' };
  if (new Date(ms).getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
  return `${new Date(ms).toLocaleDateString([], opts)} at ${clock(ms)}`;
}

export function ago(at, now = Date.now()) {
  const ms = toMs(at);
  if (Number.isNaN(ms)) return '';
  const diff = now - ms;
  if (diff < 45 * 1000) return 'just now';
  if (diff < HOUR) { const m = Math.max(1, Math.round(diff / MIN)); return `${m} minute${m === 1 ? '' : 's'} ago`; }
  if (diff < 6 * HOUR) { const hr = Math.round(diff / HOUR); return `${hr} hour${hr === 1 ? '' : 's'} ago`; }
  return dayAndTime(ms, now);
}

export function dateOnly(at) {
  const ms = toMs(at);
  if (Number.isNaN(ms)) return '';
  const opts = { day: 'numeric', month: 'short' };
  if (new Date(ms).getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(ms).toLocaleDateString([], opts);
}

// 9:05, for a countdown.
export function minutesSeconds(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// "for 25 minutes", "for 2 hours".
export function duration(fromMs, now = Date.now()) {
  const diff = Math.max(0, now - toMs(fromMs));
  if (diff < MIN) return 'less than a minute';
  if (diff < HOUR) { const m = Math.round(diff / MIN); return `${m} minute${m === 1 ? '' : 's'}`; }
  const hr = Math.floor(diff / HOUR);
  return `${hr} hour${hr === 1 ? '' : 's'}`;
}

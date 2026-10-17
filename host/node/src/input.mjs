// Checks every mouse, keyboard and touch message from a viewer before it can reach the app. See docs/PROTOCOL.md,
// "Input and pointer channels".
//
// Only the fields listed in the protocol are passed on, with the right types and sensible ranges; anything else is
// dropped. The app then posts real events on the Mac, so this is the last line between a browser tab and the
// keyboard: be strict, and never forward something we didn't build ourselves.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const coord = v => (isNum(v) ? clamp(v, 0, 1) : null);

export const MAX_TEXT_CHARS = 256;
export const MAX_SCROLL = 10000;          // CSS pixels in one wheel event
const CODE_RE = /^[A-Za-z0-9]{1,32}$/;    // DOM KeyboardEvent.code, e.g. "KeyA", "ArrowLeft", "Digit1"
// Control characters other than tab and newline (and DEL) have no business in typed text.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

// Returns a clean copy of the message, or null to drop it. `channel` is 'pointer' or 'input'.
export function validateInput(msg, channel) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (channel === 'pointer') {
    if (msg.t !== 'm') return null;
    const x = coord(msg.x), y = coord(msg.y);
    return x === null || y === null ? null : { t: 'm', x, y };
  }
  if (channel !== 'input') return null;
  switch (msg.t) {
    case 'b': {
      const x = coord(msg.x), y = coord(msg.y);
      if (x === null || y === null || ![0, 1, 2].includes(msg.b) || typeof msg.d !== 'boolean') return null;
      const n = Number.isInteger(msg.n) ? clamp(msg.n, 1, 3) : 1;
      return { t: 'b', b: msg.b, d: msg.d, x, y, n };
    }
    case 'w': {
      const x = coord(msg.x), y = coord(msg.y);
      if (x === null || y === null || !isNum(msg.dx) || !isNum(msg.dy)) return null;
      if (msg.dx === 0 && msg.dy === 0) return null;
      return { t: 'w', dx: clamp(msg.dx, -MAX_SCROLL, MAX_SCROLL), dy: clamp(msg.dy, -MAX_SCROLL, MAX_SCROLL), x, y };
    }
    case 'k': {
      if (typeof msg.c !== 'string' || !CODE_RE.test(msg.c) || typeof msg.d !== 'boolean') return null;
      const k = typeof msg.k === 'string' && msg.k.length <= 32 ? msg.k : '';
      const m = Number.isInteger(msg.m) ? msg.m & 15 : 0;
      return { t: 'k', c: msg.c, k, d: msg.d, m };
    }
    case 'txt': {
      if (typeof msg.s !== 'string' || msg.s.length > MAX_TEXT_CHARS * 2) return null;
      const s = msg.s.replace(CONTROL_RE, '');
      if (!s || [...s].length > MAX_TEXT_CHARS) return null;
      return { t: 'txt', s };
    }
    case 'rel':
      return { t: 'rel' };
    default:
      return null;
  }
}

// A token bucket: `rate` messages a second on average, bursts of up to `burst`. Excess messages are dropped, so a
// runaway or hostile page can't flood the app with events.
export class RateLimiter {
  constructor({ rate, burst = rate, now = () => performance.now() }) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.last = now();
  }
  take() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (t - this.last) * this.rate / 1000);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// Limits per viewer. Pointer moves come at the display's refresh rate (up to 120 Hz on ProMotion screens, more with
// coalesced events); keys and clicks are far rarer, but typing bursts and key repeat need room.
export const POINTER_RATE = { rate: 250, burst: 60 };
export const INPUT_RATE = { rate: 100, burst: 100 };
export const CONTROL_RATE = { rate: 20, burst: 40 };

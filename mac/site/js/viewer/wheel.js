// Scrolling: the Mac wants DOM WheelEvent deltas in CSS pixels (docs/PROTOCOL.md, `{t:"w"}`), positive dy meaning the
// page moves up (what scrolling down does). Most browsers already report pixels; Firefox with a mouse wheel reports
// lines (deltaMode 1), and some settings report whole pages (deltaMode 2), so those get converted here.

export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;
export const DOM_DELTA_PAGE = 2;

// 40 px per line is what Chrome and Safari use for one notch's worth of "lines" and what most web apps assume; it makes
// a Firefox mouse notch (3 lines) scroll about as far as one notch in Chrome (100–120 px).
export const LINE_PX = 40;

export function wheelPixels({ deltaX = 0, deltaY = 0, deltaMode = 0 }, { lineHeight = LINE_PX, pageWidth = 800, pageHeight = 600 } = {}) {
  let fx = 1, fy = 1;
  if (deltaMode === DOM_DELTA_LINE) fx = fy = lineHeight;
  else if (deltaMode === DOM_DELTA_PAGE) { fx = pageWidth; fy = pageHeight; }
  return { dx: deltaX * fx, dy: deltaY * fy };
}

// Trackpads send a wheel event for every tiny movement, often several per screen refresh. Adding them up and sending
// one message per animation frame keeps the input channel short without losing any distance.
export class WheelAccumulator {
  constructor() { this.reset(); }
  reset() { this.dx = 0; this.dy = 0; this.x = 0; this.y = 0; this.pending = false; }
  add(dx, dy, x, y) {
    this.dx += dx;
    this.dy += dy;
    this.x = x;
    this.y = y;
    this.pending = true;
  }
  // The message to send now, or null when there is nothing (or less than a hundredth of a pixel) to send.
  take() {
    if (!this.pending) return null;
    const msg = { t: 'w', dx: round2(this.dx), dy: round2(this.dy), x: this.x, y: this.y };
    this.reset();
    return msg.dx === 0 && msg.dy === 0 ? null : msg;
  }
}

const round2 = v => Math.round(v * 100) / 100;

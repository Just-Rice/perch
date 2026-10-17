// Click counting for the Mac: macOS decides "double click" from a count carried with each button event, not from
// timing, so the viewer has to count. Browsers disagree on what PointerEvent.detail holds, so Perch counts itself.

export const CLICK_MS = 500; // macOS's default double-click speed is about half a second
export const CLICK_SLOP = 5;  // pixels the pointer may move between the clicks

export class ClickCounter {
  constructor({ ms = CLICK_MS, slop = CLICK_SLOP } = {}) {
    this.ms = ms;
    this.slop = slop;
    this.last = null; // {b, x, y, t, n}
  }

  // A button went down at page position (x, y) at time t: returns its click count (1, 2, 3, then 1 again).
  down(b, x, y, t) {
    const l = this.last;
    let n = 1;
    if (l && l.b === b && t - l.t <= this.ms && Math.abs(x - l.x) <= this.slop && Math.abs(y - l.y) <= this.slop) {
      n = l.n >= 3 ? 1 : l.n + 1;
    }
    this.last = { b, x, y, t, n };
    return n;
  }

  // The count for the matching button-up (the same as its down).
  up(b) {
    return this.last && this.last.b === b ? this.last.n : 1;
  }
}

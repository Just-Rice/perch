// Touch gestures for phones and tablets, as a pure state machine: feed it finger events, it returns actions.
//
//   tap                      → left click where the finger was (a second tap soon after → double click)
//   long press (~0.5 s)      → right click
//   short hold, then drag    → drag with the left button held (moving files, selecting text)
//   one finger moved at once → just moves the Mac's pointer (for menus and tooltips)
//   two fingers moved        → scroll (or, when zoomed in, move around the zoomed picture)
//   pinch                    → zoom this view in or out (nothing changes on the Mac)
//   two-finger double tap    → back to the whole screen
//
// Positions in and out are page (client) pixels; viewer/pointer.js maps them to the Mac's screen and sends them.
// Time comes in as an argument (milliseconds) so tests can replay exact sequences. When nextTimer() returns a time,
// call tick(time) then: that's how a long press fires while the finger stays still.

export const TOUCH = Object.freeze({
  SLOP_PX: 10,         // a finger can wobble this much and still count as still
  DOUBLE_SLOP_PX: 30,  // how close the second tap of a double tap must land
  DOUBLE_MS: 350,      // longest gap between the taps of a double tap
  DRAG_HOLD_MS: 250,   // hold at least this long before moving to drag rather than just move the pointer
  LONG_PRESS_MS: 550,  // hold this long without moving for a right click
  TWO_TAP_MS: 300,     // two fingers down and up within this is a two-finger tap
  PINCH_PX: 24,        // fingers this much closer or further apart (and more than they moved together) is a pinch
});

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

export class TouchGestures {
  constructor({ isZoomed = () => false, options = {} } = {}) {
    this.isZoomed = isZoomed;
    this.o = { ...TOUCH, ...options };
    this.touches = new Map(); // id -> {x, y}
    this.state = 'idle';      // idle | one | two | rest (extra fingers: ignore until all are lifted)
    this.one = null;
    this.two = null;
    this.timerAt = null;
    this.lastTap = null;      // {x, y, t, n}
    this.lastTwoTap = null;   // time
  }

  nextTimer() { return this.timerAt; }

  down(id, x, y, t) {
    const out = [];
    this.touches.set(id, { x, y });
    if (this.state === 'idle') {
      this.state = 'one';
      this.one = { id, sx: x, sy: y, x, y, st: t, mode: 'pending' };
      this.timerAt = t + this.o.LONG_PRESS_MS;
    } else if (this.state === 'one') {
      // A second finger: whatever the first one was doing becomes a two-finger gesture.
      if (this.one.mode === 'drag') out.push({ a: 'up', b: 0, x: this.one.x, y: this.one.y });
      this.one = null;
      this.timerAt = null;
      this._startTwo(t);
    } else if (this.state === 'two') {
      this.state = 'rest';
      this.two = null;
    }
    return out;
  }

  move(id, x, y, t) {
    const out = [];
    const p = this.touches.get(id);
    if (!p) return out;
    p.x = x;
    p.y = y;
    if (this.state === 'one' && this.one.id === id) {
      const g = this.one;
      g.x = x;
      g.y = y;
      if (g.mode === 'pending' && dist(x, y, g.sx, g.sy) > this.o.SLOP_PX) {
        this.timerAt = null;
        if (t - g.st < this.o.DRAG_HOLD_MS) {
          g.mode = 'hover';
        } else {
          g.mode = 'drag';
          out.push({ a: 'down', b: 0, x: g.sx, y: g.sy });
        }
      }
      if (g.mode === 'hover') out.push({ a: 'move', x, y });
      else if (g.mode === 'drag') out.push({ a: 'drag', x, y });
    } else if (this.state === 'two' && this.two.ids.includes(id)) {
      out.push(...this._moveTwo());
    }
    return out;
  }

  up(id, x, y, t) {
    const out = [];
    if (!this.touches.has(id)) return out;
    this.touches.delete(id);
    if (this.state === 'one' && this.one.id === id) {
      const g = this.one;
      if (g.mode === 'pending') out.push(this._tap(g, t));
      else if (g.mode === 'drag') out.push({ a: 'up', b: 0, x, y });
      this._reset();
    } else if (this.state === 'two') {
      if (this.two.mode === 'pending' && t - this.two.st <= this.o.TWO_TAP_MS) {
        if (this.lastTwoTap !== null && this.two.st - this.lastTwoTap <= this.o.DOUBLE_MS) {
          out.push({ a: 'reset' });
          this.lastTwoTap = null;
        } else {
          this.lastTwoTap = t;
        }
      }
      this.two = null;
      this.state = this.touches.size ? 'rest' : 'idle';
    } else if (this.state === 'rest' && this.touches.size === 0) {
      this.state = 'idle';
    }
    return out;
  }

  // The browser took the touches away (a system gesture, an alert): let go of anything held.
  cancel() {
    const out = [];
    if (this.state === 'one' && this.one.mode === 'drag') out.push({ a: 'up', b: 0, x: this.one.x, y: this.one.y });
    this.touches.clear();
    this._reset();
    return out;
  }

  tick(t) {
    if (this.timerAt === null || t < this.timerAt) return [];
    this.timerAt = null;
    if (this.state !== 'one' || this.one.mode !== 'pending') return [];
    this.one.mode = 'done'; // the finger is still down, but this touch has done its job
    this.lastTap = null;
    return [{ a: 'click', b: 2, n: 1, x: this.one.sx, y: this.one.sy }];
  }

  // --- internals ---

  _tap(g, t) {
    let n = 1, x = g.sx, y = g.sy;
    const last = this.lastTap;
    if (last && g.st - last.t <= this.o.DOUBLE_MS && dist(x, y, last.x, last.y) <= this.o.DOUBLE_SLOP_PX) {
      // Click where the first tap was: the Mac only counts a double click if both land on (almost) the same spot.
      n = Math.min(last.n + 1, 3);
      x = last.x;
      y = last.y;
    }
    this.lastTap = { x, y, t, n };
    return { a: 'click', b: 0, n, x, y };
  }

  _startTwo(t) {
    const [a, b] = [...this.touches.entries()];
    const c = { x: (a[1].x + b[1].x) / 2, y: (a[1].y + b[1].y) / 2 };
    const d = Math.max(1, dist(a[1].x, a[1].y, b[1].x, b[1].y));
    this.state = 'two';
    this.two = { ids: [a[0], b[0]], st: t, mode: 'pending', c0: c, d0: d, c, d, half: false };
  }

  _moveTwo() {
    const g = this.two;
    const [a, b] = g.ids.map(id => this.touches.get(id));
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.max(1, dist(a.x, a.y, b.x, b.y));
    if (g.mode === 'pending') {
      // Browsers report each finger's move as its own event. Halfway through a two-finger scroll only one finger has
      // moved, which looks just like a pinch, so only decide on every second event: by then both fingers have
      // reported (or one finger moved twice while the other stayed put, as in a thumb-still pinch).
      g.half = !g.half;
      if (g.half) return [];
      const spread = Math.abs(d - g.d0), shift = dist(c.x, c.y, g.c0.x, g.c0.y);
      if (spread > this.o.PINCH_PX && spread > shift) g.mode = 'pinch';
      else if (shift > this.o.SLOP_PX && shift >= spread) g.mode = this.isZoomed() ? 'pan' : 'scroll';
    }
    const out = [];
    const dx = c.x - g.c.x, dy = c.y - g.c.y;
    if (g.mode === 'pinch') {
      out.push({ a: 'zoom', factor: d / g.d, cx: c.x, cy: c.y });
      if (dx || dy) out.push({ a: 'pan', dx, dy });
    } else if (g.mode === 'pan') {
      out.push({ a: 'pan', dx, dy });
    } else if (g.mode === 'scroll') {
      // Fingers moving up push the page up, like scrolling on a phone; for the Mac that's a positive wheel delta.
      out.push({ a: 'scroll', dx: -dx, dy: -dy, x: c.x, y: c.y });
    }
    if (g.mode !== 'pending') {
      g.c = c;
      g.d = d;
    }
    return out;
  }

  _reset() {
    this.state = this.touches.size ? 'rest' : 'idle';
    this.one = null;
    this.two = null;
    this.timerAt = null;
  }
}

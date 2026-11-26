// The Mac's displays as they sit on the desk, for the display picker's map and for the edge flip: holding the pointer
// at an edge of the picture (or pushing a captured mouse past it) moves the view to the display beyond that edge, as
// the pointer would move at the Mac. Pure: no page, no clock of its own.
//
// Displays are {id, name, width, height, x?, y?, main} in points; x and y are the top-left corner in the Mac's
// arrangement (System Settings › Displays). A Mac from before 0.3.3 doesn't send them: its displays are then taken to
// sit side by side, left to right, in the order listed.

export const EDGE_DWELL_MS = 400;   // resting at the edge this long flips
export const EDGE_PUSH = 0.04;      // a captured mouse pushed this far past the edge (fraction of the picture) flips at once
const TOUCH_PT = 2;                 // how close two edges count as touching, in points

const placed = (displays) => displays.length > 0 && displays.every(d => Number.isFinite(d.x) && Number.isFinite(d.y));

// Every display with a position: the Mac's own, or side by side.
export function arrangement(displays) {
  if (placed(displays)) return displays.map(d => ({ ...d }));
  let x = 0;
  return displays.map(d => { const r = { ...d, x, y: 0 }; x += d.width || 1; return r; });
}

// The display beyond `edge` ('left' | 'right' | 'top' | 'bottom') of `shown`, where the pointer is `along` it (0..1,
// left to right or top to bottom), or null when nothing is there.
export function neighbour(displays, shown, edge, along) {
  if (!shown || displays.length < 2) return null;
  const all = arrangement(displays);
  const from = all.find(d => d.id === shown.id);
  if (!from) return null;
  const a = Math.min(1, Math.max(0, along));
  const gx = edge === 'right' ? from.x + from.width : edge === 'left' ? from.x : from.x + a * from.width;
  const gy = edge === 'bottom' ? from.y + from.height : edge === 'top' ? from.y : from.y + a * from.height;
  const within = (v, lo, len) => v >= lo - TOUCH_PT && v <= lo + len + TOUCH_PT;
  const hit = all.find(d => {
    if (d.id === from.id) return false;
    switch (edge) {
      case 'right': return Math.abs(d.x - gx) <= TOUCH_PT && within(gy, d.y, d.height);
      case 'left': return Math.abs(d.x + d.width - gx) <= TOUCH_PT && within(gy, d.y, d.height);
      case 'bottom': return Math.abs(d.y - gy) <= TOUCH_PT && within(gx, d.x, d.width);
      case 'top': return Math.abs(d.y + d.height - gy) <= TOUCH_PT && within(gx, d.x, d.width);
      default: return false;
    }
  });
  return hit ? displays.find(d => d.id === hit.id) : null;
}

// Where the pointer comes in on `to` after leaving `from` across `edge` at `along`: at the facing edge, level with
// where it left (0..1 on `to`).
export function entryPoint(displays, from, to, edge, along) {
  const all = arrangement(displays);
  const f = all.find(d => d.id === from.id), t = all.find(d => d.id === to.id);
  if (!f || !t) return { x: 0.5, y: 0.5 };
  const clamp = v => Math.min(1, Math.max(0, v));
  if (edge === 'left' || edge === 'right') {
    const gy = f.y + along * f.height;
    return { x: edge === 'right' ? 0 : 1, y: clamp((gy - t.y) / (t.height || 1)) };
  }
  const gx = f.x + along * f.width;
  return { x: clamp((gx - t.x) / (t.width || 1)), y: edge === 'bottom' ? 0 : 1 };
}

// Which edge a pointer position (0..1, clamped to the picture) is on, if any.
export function edgeOf(p) {
  if (p.x >= 1) return 'right';
  if (p.x <= 0) return 'left';
  if (p.y <= 0) return 'top';
  if (p.y >= 1) return 'bottom';
  return null;
}

// The edge flip. `find(edge, along)` names the display beyond an edge (neighbour() above). move() is called with each
// pointer position; it answers {hint} while the pointer waits at an edge with a display beyond it, or {flip} when it is
// time to go there. tick() is for a timer: a pointer resting at the edge sends no more moves. After a flip nothing more
// happens until the pointer has left the edge, so arriving at the far side doesn't flip straight back.
export class EdgeFlip {
  constructor(find) {
    this.find = find;
    this.armed = true;
    this.at = null;      // {edge, along, target, since}
    this.pushed = 0;
  }

  move(p, now, push = 0) {
    const edge = edgeOf(p);
    if (!edge) { this.reset(); return null; }
    if (!this.armed) return null;
    const along = edge === 'left' || edge === 'right' ? p.y : p.x;
    const target = this.find(edge, along);
    if (!target) { this.at = null; this.pushed = 0; return null; }
    if (!this.at || this.at.edge !== edge || this.at.target.id !== target.id) {
      this.at = { edge, along, target, since: now };
      this.pushed = 0;
    }
    this.at.along = along;
    this.pushed += Math.max(0, push);
    if (this.pushed >= EDGE_PUSH) return this._flip();
    return { hint: this.at };
  }

  tick(now) {
    if (this.armed && this.at && now - this.at.since >= EDGE_DWELL_MS) return this._flip();
    return null;
  }

  // The pointer left the picture, or the displays changed: start again.
  reset() { this.armed = true; this.at = null; this.pushed = 0; }

  _flip() {
    const f = this.at;
    this.at = null; this.pushed = 0; this.armed = false;
    return { flip: f };
  }
}

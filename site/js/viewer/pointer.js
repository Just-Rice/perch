// Mouse, pen and touch on the PC's picture → pointer and input messages (docs/PROTOCOL.md, "Input and pointer
// channels"). The decisions are made by pure modules (coords.js, wheel.js, touch.js, clicks.js); this file only listens
// to the page and sends.
import { toDisplay, zoomAround, panView, isZoomed, IDENTITY, FIT, followPan, shownScale } from './coords.js';
import { wheelPixels, WheelAccumulator } from './wheel.js';
import { TouchGestures } from './touch.js';
import { ClickCounter } from './clicks.js';
import { SwipeDetector } from './shortcuts.js';

// The last 2 page pixels at each side of the picture are the PC's very edge (see coords.js).
const EDGE_PX = 2;

// A captured mouse's speed, chosen in More: from a fifth as fast to twice as fast as the page's own pointer.
export const MIN_SPEED = 0.2, MAX_SPEED = 2;

// Touchpad mode: the PC's pointer moves this many times as far as the finger, across the picture.
const TOUCHPAD_SPEED = 1.6;

export class PointerInput {
  // surface: the element that gets the events (not transformed); video: for the picture size;
  // session: {sendInput, sendPointer}; view: {get(), set(view)} for local zoom; size(): fallback picture size.
  // touchpad(): true when a finger should move the PC's pointer like a laptop's touchpad (from where the pointer
  // is, by how far the finger goes) instead of clicking right under the finger.
  // onSwipe(dir): a swipe sideways (two fingers on a touchpad, three on a touch screen; +1 next, -1 previous) or up
  // and down with three fingers ('up', 'down'). swipesOn(): whether a touchpad's sideways swipe is one (or scrolls).
  // layout: {get(), pan(p)}: the picture's shape and where a "fill" picture has slid to (coords.js), and sliding it.
  // onEdge(pos, push, locked): every mouse or pen position (0..1), for the edge flip (displays.js); `push` is how far a
  // captured mouse tried to go past the picture's edge. It may answer a new position for a captured mouse (where it
  // comes in on the display beyond). Called with null when the pointer leaves the picture.
  constructor({ surface, video, session, view, size, enabled = () => true, onActivity = () => {}, touchpad = () => false,
    onSwipe = () => {}, swipesOn = () => false, layout = { get: () => FIT, pan: () => {} }, mouseSpeed = () => 1, onEdge = () => null }) {
    // mouseSpeed(): how far a captured mouse moves the PC's pointer, 1 = as far as on this screen.
    Object.assign(this, { surface, video, session, view, size, enabled, onActivity, touchpad, onSwipe, swipesOn, layout, mouseSpeed, onEdge });
    this.swipe = new SwipeDetector();
    this.clicks = new ClickCounter();
    this.wheel = new WheelAccumulator();
    // A "fill" picture is moved around with two fingers on a touch screen, as a zoomed one is.
    this.gestures = new TouchGestures({ isZoomed: () => isZoomed(this.view.get()) || this._fills() });
    this.pendingMove = null;
    this.frame = 0;
    this.gestureTimer = null;
    this.buttons = new Set();
    this.listeners = [];
    // A captured mouse (pointer lock): the page's own pointer is hidden and stays put, so the PC's pointer is moved
    // by how far the mouse goes, from where it last was.
    this.locked = false;
    this.last = { x: 0.5, y: 0.5 };
  }

  attach() {
    const s = this.surface;
    const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); this.listeners.push([el, type, fn, opts]); };
    on(s, 'pointerdown', e => this._down(e));
    on(s, 'pointermove', e => this._move(e));
    on(s, 'pointerup', e => this._up(e));
    on(s, 'pointercancel', e => this._cancel(e));
    on(s, 'pointerleave', e => { if (e.pointerType !== 'touch' && !this.locked) this.onEdge(null, 0, false); });
    on(s, 'lostpointercapture', e => { if (e.pointerType !== 'touch') this._releaseButtons(e); });
    on(s, 'wheel', e => this._wheel(e), { passive: false });
    on(s, 'contextmenu', e => e.preventDefault());
    // Safari's own pinch-to-zoom of the whole page would fight the local zoom.
    on(s, 'gesturestart', e => e.preventDefault());
    on(s, 'dragstart', e => e.preventDefault());
    on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === s;
      this.pendingMove = null;
    });
  }

  // Where an event is on the PC's screen: under the page's pointer, or, with the mouse captured, wherever the
  // PC's pointer has been moved to.
  pos(e) {
    if (this.locked) return { ...this.last };
    const p = this.map(e.clientX, e.clientY, true);
    this.last = { x: p.x, y: p.y };
    return p;
  }

  // How wide and tall the picture is on screen, in page pixels (zoom included).
  shownSize() {
    const box = this.surface.getBoundingClientRect();
    const [w, h] = this.pictureSize();
    const z = this.view.get().scale ?? 1;
    const [sx, sy] = shownScale(box.width, box.height, w, h, this.layout.get().shape);
    // Moving across the whole PC takes one window's width at most, even when a "fill" picture is wider than that.
    return [Math.min(w * sx, box.width) * z, Math.min(h * sy, box.height) * z];
  }

  _fills() { return this.layout.get().shape === 'fill'; }

  // "fill": the picture slides after the PC's pointer (moved by a captured mouse or a touchpad finger), so the part
  // of the PC it's on is in view.
  _followLast() {
    if (this._fills()) this.layout.pan({ x: this.last.x, y: this.last.y });
  }

  detach() {
    for (const [el, type, fn, opts] of this.listeners) el.removeEventListener(type, fn, opts);
    this.listeners = [];
    cancelAnimationFrame(this.frame);
    clearTimeout(this.gestureTimer);
  }

  // Page position → the PC's display (0..1). `follow`: a mouse or pen; with "fill" the picture first slides so
  // that the pointer's place in the window is its place on the PC (touches use the picture where it is).
  map(clientX, clientY, follow = false) {
    const box = this.surface.getBoundingClientRect();
    const [w, h] = this.pictureSize();
    let layout = this.layout.get();
    if (follow && layout.shape === 'fill') {
      const pan = followPan(clientX, clientY, box, this.view.get());
      this.layout.pan(pan);
      layout = { ...layout, pan };
    }
    return toDisplay(clientX, clientY, box, w, h, this.view.get(), EDGE_PX, layout);
  }

  pictureSize() {
    const v = this.video;
    if (v.videoWidth > 0 && v.videoHeight > 0) return [v.videoWidth, v.videoHeight];
    return this.size();
  }

  // --- mouse and pen ---

  _down(e) {
    if (!this.enabled()) return;
    this.onActivity(e);
    if (e.pointerType === 'touch') return this._touch('down', e);
    if (e.button > 2) return; // back/forward buttons: nothing on the Mac to map them to
    e.preventDefault();
    this.surface.focus({ preventScroll: true });
    if (!this.locked) { try { this.surface.setPointerCapture(e.pointerId); } catch {} }
    const p = this.pos(e);
    const n = this.clicks.down(e.button, e.clientX, e.clientY, e.timeStamp);
    this.buttons.add(e.button);
    this._flushMove();
    this.session.sendInput({ t: 'b', b: e.button, d: true, x: p.x, y: p.y, n });
  }

  _move(e) {
    if (!this.enabled()) return;
    if (e.pointerType === 'touch') return this._touch('move', e);
    this.onActivity(e);
    if (this.locked) {
      const [sw, sh] = this.shownSize();
      if (!(sw > 0 && sh > 0) || (!e.movementX && !e.movementY)) return;
      const k = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(this.mouseSpeed()) || 1));
      const dx = e.movementX * k / sw, dy = e.movementY * k / sh;
      const clamp = v => Math.min(1, Math.max(0, v));
      const rx = this.last.x + dx, ry = this.last.y + dy;
      this.last = { x: clamp(rx), y: clamp(ry) };
      const across = this.onEdge({ ...this.last }, Math.max(0, rx - 1, -rx, ry - 1, -ry), true);
      if (across) this.last = { x: across.x, y: across.y };
      this._followLast();
      // Several moves between two screen refreshes go out as one: the newest position, and all the movement.
      const m = this.pendingMove?.dx !== undefined ? this.pendingMove : { dx: 0, dy: 0 };
      this.pendingMove = { t: 'm', x: this.last.x, y: this.last.y, dx: m.dx + dx, dy: m.dy + dy };
      this._schedule();
      return;
    }
    const p = this.pos(e);
    this.onEdge(p, 0, false);
    this._queueMove(p.x, p.y);
  }

  _up(e) {
    if (e.pointerType === 'touch') return this._touch('up', e);
    if (!this.buttons.has(e.button)) return;
    this.buttons.delete(e.button);
    const p = this.pos(e);
    this._flushMove();
    this.session.sendInput({ t: 'b', b: e.button, d: false, x: p.x, y: p.y, n: this.clicks.up(e.button) });
  }

  _cancel(e) {
    if (e.pointerType === 'touch') return this._run(this.gestures.cancel());
    this._releaseButtons(e);
  }

  _releaseButtons(e) {
    const p = this.pos(e);
    for (const b of this.buttons) this.session.sendInput({ t: 'b', b, d: false, x: p.x, y: p.y, n: 1 });
    this.buttons.clear();
  }

  _wheel(e) {
    if (!this.enabled()) return;
    e.preventDefault();
    this.onActivity(e);
    const { dx, dy } = wheelPixels(e, { pageWidth: this.surface.clientWidth, pageHeight: this.surface.clientHeight });
    // Not a mouse wheel's notches (whole lines or pages) and not Shift+wheel: a touchpad, where sideways is a swipe.
    if (e.deltaMode === 0 && !e.shiftKey && this.swipesOn()) {
      const r = this.swipe.wheel(dx, dy, e.timeStamp);
      if (r.swipe) this.onSwipe(r.swipe);
      if (!r.pass) return;
    }
    const p = this.pos(e);
    this.wheel.add(dx, dy, p.x, p.y);
    this._schedule();
  }

  // Moves go out at most once per screen refresh: the newest position replaces any not yet sent.
  _queueMove(x, y) {
    this.pendingMove = { t: 'm', x, y };
    this._schedule();
  }

  _schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this._flushMove();
      const w = this.wheel.take();
      if (w) this.session.sendInput(w);
    });
  }

  _flushMove() {
    if (!this.pendingMove) return;
    this.session.sendPointer(this.pendingMove);
    this.pendingMove = null;
  }

  // --- touch ---

  _touch(kind, e) {
    e.preventDefault();
    if (kind === 'down') {
      // While the phone keyboard is up, leave focus in its text box: moving it to the picture would close the
      // keyboard on every tap (tap a text field on the PC, and the keyboard you were about to type with is gone).
      if (!document.activeElement?.classList?.contains('softkbd')) this.surface.focus({ preventScroll: true });
      try { this.surface.setPointerCapture(e.pointerId); } catch {}
    }
    const g = this.gestures;
    const t = e.timeStamp;
    // Touchpad mode: each new gesture starts from where this finger lands.
    if (kind === 'down' && g.state === 'idle') this.finger = { x: e.clientX, y: e.clientY };
    const actions = kind === 'down' ? g.down(e.pointerId, e.clientX, e.clientY, t)
      : kind === 'move' ? g.move(e.pointerId, e.clientX, e.clientY, t)
        : g.up(e.pointerId, e.clientX, e.clientY, t);
    this._run(actions);
    this._armTimer();
  }

  // A long press fires while the finger is still: ask the gesture machine again when its timer is due.
  _armTimer() {
    clearTimeout(this.gestureTimer);
    const at = this.gestures.nextTimer();
    if (at === null) return;
    const delay = Math.max(0, at - performance.now());
    this.gestureTimer = setTimeout(() => {
      this._run(this.gestures.tick(performance.now()));
      this._armTimer();
    }, delay);
  }

  // Touchpad mode: moving the finger moves the PC's pointer by as much (a little more, so one swipe crosses the
  // screen), and taps, presses and scrolls happen where the PC's pointer is, not under the finger.
  _touchpadAction(a) {
    if (a.a === 'move' || a.a === 'drag') {
      const from = this.finger ?? { x: a.x, y: a.y };
      this.finger = { x: a.x, y: a.y };
      const [sw, sh] = this.shownSize();
      if (!(sw > 0 && sh > 0)) return;
      const clamp = v => Math.min(1, Math.max(0, v));
      this.last = { x: clamp(this.last.x + (a.x - from.x) * TOUCHPAD_SPEED / sw), y: clamp(this.last.y + (a.y - from.y) * TOUCHPAD_SPEED / sh) };
      this._followLast();
      this._queueMove(this.last.x, this.last.y);
      return;
    }
    const p = this.last;
    if (a.a === 'scroll') {
      this.wheel.add(a.dx, a.dy, p.x, p.y);
      this._schedule();
    } else if (a.a === 'click') {
      this._flushMove();
      this.session.sendInput({ t: 'b', b: a.b, d: true, x: p.x, y: p.y, n: a.n });
      this.session.sendInput({ t: 'b', b: a.b, d: false, x: p.x, y: p.y, n: a.n });
      if (a.b === 2) navigator.vibrate?.(15);
    } else if (a.a === 'down' || a.a === 'up') {
      this._flushMove();
      this.session.sendInput({ t: 'b', b: a.b, d: a.a === 'down', x: p.x, y: p.y, n: 1 });
    }
  }

  _run(actions) {
    for (const a of actions) {
      if (a.a === 'pan' && !isZoomed(this.view.get()) && this._fills()) {
        // Two fingers move a "fill" picture: the hidden part comes into view as the fingers drag it in.
        const box = this.surface.getBoundingClientRect();
        const [w, h] = this.pictureSize();
        const [sx, sy] = shownScale(box.width, box.height, w, h, 'fill');
        const spareX = w * sx - box.width, spareY = h * sy - box.height;
        const pan = this.layout.get().pan;
        const clamp = v => Math.min(1, Math.max(0, v));
        this.layout.pan({ x: spareX > 0.5 ? clamp(pan.x - a.dx / spareX) : 0.5, y: spareY > 0.5 ? clamp(pan.y - a.dy / spareY) : 0.5 });
        continue;
      }
      if (a.a === 'zoom' || a.a === 'pan' || a.a === 'reset') {
        const box = this.surface.getBoundingClientRect();
        const v = this.view.get();
        this.view.set(a.a === 'zoom' ? zoomAround(v, a.factor, a.cx, a.cy, box)
          : a.a === 'pan' ? panView(v, a.dx, a.dy, box) : IDENTITY);
        continue;
      }
      if (a.a === 'swipe') {
        this.onSwipe(a.dir);
        continue;
      }
      if (this.touchpad()) {
        this._touchpadAction(a);
        continue;
      }
      if (a.a === 'scroll') {
        const p = this.map(a.x, a.y);
        this.wheel.add(a.dx, a.dy, p.x, p.y);
        this._schedule();
        continue;
      }
      const p = this.map(a.x, a.y);
      this.last = { x: p.x, y: p.y };
      if (a.a === 'move' || a.a === 'drag') {
        this._queueMove(p.x, p.y);
      } else if (a.a === 'click') {
        this._flushMove();
        this.session.sendInput({ t: 'b', b: a.b, d: true, x: p.x, y: p.y, n: a.n });
        this.session.sendInput({ t: 'b', b: a.b, d: false, x: p.x, y: p.y, n: a.n });
        if (a.b === 2) navigator.vibrate?.(15); // a little buzz says "that was a right click"
      } else if (a.a === 'down' || a.a === 'up') {
        this._flushMove();
        this.session.sendInput({ t: 'b', b: a.b, d: a.a === 'down', x: p.x, y: p.y, n: 1 });
      }
    }
  }
}

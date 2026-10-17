// Mouse, pen and touch on the Mac's picture → pointer and input messages (docs/PROTOCOL.md, "Input and pointer
// channels"). The decisions are made by pure modules (coords.js, wheel.js, touch.js, clicks.js); this file only listens
// to the page and sends.
import { toDisplay, zoomAround, panView, isZoomed, IDENTITY } from './coords.js';
import { wheelPixels, WheelAccumulator } from './wheel.js';
import { TouchGestures } from './touch.js';
import { ClickCounter } from './clicks.js';

export class PointerInput {
  // surface: the element that gets the events (not transformed); video: for the picture size;
  // session: {sendInput, sendPointer}; view: {get(), set(view)} for local zoom; size(): fallback picture size.
  constructor({ surface, video, session, view, size, enabled = () => true, onActivity = () => {} }) {
    Object.assign(this, { surface, video, session, view, size, enabled, onActivity });
    this.clicks = new ClickCounter();
    this.wheel = new WheelAccumulator();
    this.gestures = new TouchGestures({ isZoomed: () => isZoomed(this.view.get()) });
    this.pendingMove = null;
    this.frame = 0;
    this.gestureTimer = null;
    this.buttons = new Set();
    this.listeners = [];
  }

  attach() {
    const s = this.surface;
    const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); this.listeners.push([el, type, fn, opts]); };
    on(s, 'pointerdown', e => this._down(e));
    on(s, 'pointermove', e => this._move(e));
    on(s, 'pointerup', e => this._up(e));
    on(s, 'pointercancel', e => this._cancel(e));
    on(s, 'lostpointercapture', e => { if (e.pointerType !== 'touch') this._releaseButtons(e); });
    on(s, 'wheel', e => this._wheel(e), { passive: false });
    on(s, 'contextmenu', e => e.preventDefault());
    // Safari's own pinch-to-zoom of the whole page would fight the local zoom.
    on(s, 'gesturestart', e => e.preventDefault());
    on(s, 'dragstart', e => e.preventDefault());
  }

  detach() {
    for (const [el, type, fn, opts] of this.listeners) el.removeEventListener(type, fn, opts);
    this.listeners = [];
    cancelAnimationFrame(this.frame);
    clearTimeout(this.gestureTimer);
  }

  // Page position → the Mac's display (0..1).
  map(clientX, clientY) {
    const box = this.surface.getBoundingClientRect();
    const [w, h] = this.pictureSize();
    return toDisplay(clientX, clientY, box, w, h, this.view.get());
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
    try { this.surface.setPointerCapture(e.pointerId); } catch {}
    const p = this.map(e.clientX, e.clientY);
    const n = this.clicks.down(e.button, e.clientX, e.clientY, e.timeStamp);
    this.buttons.add(e.button);
    this._flushMove();
    this.session.sendInput({ t: 'b', b: e.button, d: true, x: p.x, y: p.y, n });
  }

  _move(e) {
    if (!this.enabled()) return;
    if (e.pointerType === 'touch') return this._touch('move', e);
    this.onActivity(e);
    const p = this.map(e.clientX, e.clientY);
    this._queueMove(p.x, p.y);
  }

  _up(e) {
    if (e.pointerType === 'touch') return this._touch('up', e);
    if (!this.buttons.has(e.button)) return;
    this.buttons.delete(e.button);
    const p = this.map(e.clientX, e.clientY);
    this._flushMove();
    this.session.sendInput({ t: 'b', b: e.button, d: false, x: p.x, y: p.y, n: this.clicks.up(e.button) });
  }

  _cancel(e) {
    if (e.pointerType === 'touch') return this._run(this.gestures.cancel());
    this._releaseButtons(e);
  }

  _releaseButtons(e) {
    const p = this.map(e.clientX, e.clientY);
    for (const b of this.buttons) this.session.sendInput({ t: 'b', b, d: false, x: p.x, y: p.y, n: 1 });
    this.buttons.clear();
  }

  _wheel(e) {
    if (!this.enabled()) return;
    e.preventDefault();
    this.onActivity(e);
    const { dx, dy } = wheelPixels(e, { pageWidth: this.surface.clientWidth, pageHeight: this.surface.clientHeight });
    const p = this.map(e.clientX, e.clientY);
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
      this.surface.focus({ preventScroll: true });
      try { this.surface.setPointerCapture(e.pointerId); } catch {}
    }
    const g = this.gestures;
    const t = e.timeStamp;
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

  _run(actions) {
    for (const a of actions) {
      if (a.a === 'zoom' || a.a === 'pan' || a.a === 'reset') {
        const box = this.surface.getBoundingClientRect();
        const v = this.view.get();
        this.view.set(a.a === 'zoom' ? zoomAround(v, a.factor, a.cx, a.cy, box)
          : a.a === 'pan' ? panView(v, a.dx, a.dy, box) : IDENTITY);
        continue;
      }
      if (a.a === 'scroll') {
        const p = this.map(a.x, a.y);
        this.wheel.add(a.dx, a.dy, p.x, p.y);
        this._schedule();
        continue;
      }
      const p = this.map(a.x, a.y);
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

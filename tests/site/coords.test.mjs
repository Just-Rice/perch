// Pointer position → the Mac's display, through letterboxing and local zoom; scrolling; click counting.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY, MAX_ZOOM, containRect, toDisplay, fromDisplay, clampView, zoomAround, panView, isZoomed, viewTransform,
} from '../../site/js/viewer/coords.js';
import { wheelPixels, WheelAccumulator, LINE_PX, DOM_DELTA_LINE, DOM_DELTA_PAGE } from '../../site/js/viewer/wheel.js';
import { ClickCounter, CLICK_MS } from '../../site/js/viewer/clicks.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const box = (left, top, width, height) => ({ left, top, width, height });

test('containRect: a wider picture gets bars above and below', () => {
  // 1600×900 (16:9) inside 800×800: 800×450, 175 px bars top and bottom.
  assert.deepEqual(containRect(800, 800, 1600, 900), { x: 0, y: 175, width: 800, height: 450 });
});

test('containRect: a taller picture gets bars left and right', () => {
  // 1000×2000 inside 1000×1000: 500×1000, 250 px bars at the sides.
  assert.deepEqual(containRect(1000, 1000, 1000, 2000), { x: 250, y: 0, width: 500, height: 1000 });
});

test('containRect: unknown picture size fills the box', () => {
  assert.deepEqual(containRect(640, 480, 0, 0), { x: 0, y: 0, width: 640, height: 480 });
});

test('toDisplay: corners and middle with no letterbox', () => {
  const b = box(10, 20, 1440, 900);
  assert.deepEqual(toDisplay(10, 20, b, 1440, 900), { x: 0, y: 0, inside: true });
  assert.deepEqual(toDisplay(10 + 1440, 20 + 900, b, 1440, 900), { x: 1, y: 1, inside: true });
  assert.deepEqual(toDisplay(10 + 720, 20 + 450, b, 1440, 900), { x: 0.5, y: 0.5, inside: true });
});

test('toDisplay: letterboxed phone in portrait', () => {
  // A 16:10 Mac screen on a 390×844 phone: the picture is 390×243.75, starting 300.125 px down.
  const b = box(0, 0, 390, 844);
  const pic = containRect(390, 844, 1512, 945);
  near(pic.height, 243.75);
  const top = toDisplay(195, pic.y, b, 1512, 945);
  assert.equal(top.inside, true);
  near(top.y, 0);
  near(top.x, 0.5);
  const mid = toDisplay(97.5, 422, b, 1512, 945);
  near(mid.x, 0.25);
  near(mid.y, 0.5);
  // In the black bar above the picture: clamped to the top edge, and flagged as outside.
  const bar = toDisplay(195, 100, b, 1512, 945);
  assert.equal(bar.inside, false);
  assert.equal(bar.y, 0);
  const below = toDisplay(195, 800, b, 1512, 945);
  assert.equal(below.inside, false);
  assert.equal(below.y, 1);
});

test('toDisplay: pillarboxed (bars at the sides)', () => {
  const b = box(0, 0, 1000, 500);
  // 4:3 picture in a 2:1 box: 666.67 wide, bars of 166.67 at each side.
  const r = toDisplay(500, 250, b, 1024, 768);
  near(r.x, 0.5);
  near(r.y, 0.5);
  const left = toDisplay(100, 250, b, 1024, 768);
  assert.equal(left.inside, false);
  assert.equal(left.x, 0);
});

test('toDisplay: zoomed in 2× and panned', () => {
  const b = box(0, 0, 1000, 500);
  // Zoom 2× around the middle: translate(-500, -250) scale(2). The middle of the window is still the middle.
  const view = { scale: 2, x: -500, y: -250 };
  const mid = toDisplay(500, 250, b, 2000, 1000, view);
  near(mid.x, 0.5);
  near(mid.y, 0.5);
  // The window's top-left corner now shows the point a quarter of the way in.
  const tl = toDisplay(0, 0, b, 2000, 1000, view);
  near(tl.x, 0.25);
  near(tl.y, 0.25);
});

test('fromDisplay is the inverse of toDisplay (letterbox + zoom)', () => {
  const b = box(30, 40, 390, 844);
  const view = { scale: 2.5, x: -120, y: -600 };
  for (const [x, y] of [[0.1, 0.2], [0.5, 0.5], [0.9, 0.75]]) {
    const p = fromDisplay(x, y, b, 1512, 945, view);
    const back = toDisplay(p.x, p.y, b, 1512, 945, view);
    near(back.x, x);
    near(back.y, y);
  }
});

test('clampView: never zooms out past the whole picture or pans into empty space', () => {
  const b = box(0, 0, 1000, 500);
  assert.equal(clampView({ scale: 0.5, x: 10, y: 10 }, b), IDENTITY);
  assert.deepEqual(clampView({ scale: 2, x: 100, y: 100 }, b), { scale: 2, x: 0, y: 0 });
  assert.deepEqual(clampView({ scale: 2, x: -5000, y: -5000 }, b), { scale: 2, x: -1000, y: -500 });
  assert.equal(clampView({ scale: 99, x: 0, y: 0 }, b).scale, MAX_ZOOM);
});

test('zoomAround keeps the spot under the fingers in place', () => {
  const b = box(0, 0, 1000, 500);
  const v = zoomAround(IDENTITY, 2, 300, 200, b);
  assert.equal(v.scale, 2);
  // The local point that was under (300, 200) is still under it.
  near((300 - v.x) / v.scale, 300);
  near((200 - v.y) / v.scale, 200);
  const v2 = zoomAround(v, 1.5, 600, 100, b);
  near((600 - v2.x) / v2.scale, (600 - v.x) / v.scale);
  // Pinching back out past 1× goes back to the whole screen.
  assert.equal(zoomAround(v2, 0.1, 500, 250, b), IDENTITY);
});

test('panView moves a zoomed view and stops at the edges; isZoomed; viewTransform', () => {
  const b = box(0, 0, 1000, 500);
  const v = panView({ scale: 2, x: -400, y: -200 }, -50, 30, b);
  assert.deepEqual(v, { scale: 2, x: -450, y: -170 });
  assert.deepEqual(panView({ scale: 2, x: -400, y: -200 }, 1000, 1000, b), { scale: 2, x: 0, y: 0 });
  assert.equal(panView(IDENTITY, 50, 50, b), IDENTITY);
  assert.equal(isZoomed(IDENTITY), false);
  assert.equal(isZoomed(v), true);
  assert.equal(viewTransform(IDENTITY), '');
  assert.equal(viewTransform(v), 'translate(-450.00px, -170.00px) scale(2.0000)');
});

test('wheelPixels: pixels pass through, lines and pages are converted', () => {
  assert.deepEqual(wheelPixels({ deltaX: 3, deltaY: -120, deltaMode: 0 }), { dx: 3, dy: -120 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: DOM_DELTA_LINE }), { dx: 0, dy: 3 * LINE_PX });
  assert.deepEqual(wheelPixels({ deltaX: 1, deltaY: -1, deltaMode: DOM_DELTA_PAGE }, { pageWidth: 1280, pageHeight: 800 }),
    { dx: 1280, dy: -800 });
  assert.deepEqual(wheelPixels({ deltaY: 2, deltaMode: DOM_DELTA_LINE }, { lineHeight: 20 }), { dx: 0, dy: 40 });
});

test('WheelAccumulator adds up a frame of trackpad events into one message', () => {
  const w = new WheelAccumulator();
  assert.equal(w.take(), null);
  w.add(0, 1.234, 0.1, 0.2);
  w.add(0.5, 2, 0.3, 0.4);
  assert.deepEqual(w.take(), { t: 'w', dx: 0.5, dy: 3.23, x: 0.3, y: 0.4 });
  assert.equal(w.take(), null);
  w.add(0.001, -0.001, 0, 0);
  assert.equal(w.take(), null, 'tiny leftovers are not worth a message');
});

test('ClickCounter: single, double, triple, then back to one', () => {
  const c = new ClickCounter();
  assert.equal(c.down(0, 100, 100, 0), 1);
  assert.equal(c.up(0), 1);
  assert.equal(c.down(0, 102, 101, 200), 2);
  assert.equal(c.up(0), 2);
  assert.equal(c.down(0, 101, 99, 400), 3);
  assert.equal(c.down(0, 101, 99, 600), 1);
});

test('ClickCounter: too slow, too far, or another button starts again', () => {
  const c = new ClickCounter();
  c.down(0, 100, 100, 0);
  assert.equal(c.down(0, 100, 100, CLICK_MS + 1), 1, 'too slow');
  assert.equal(c.down(0, 120, 100, CLICK_MS + 100), 1, 'too far');
  assert.equal(c.down(2, 120, 100, CLICK_MS + 150), 1, 'other button');
  assert.equal(c.up(0), 1);
  assert.equal(c.up(2), 1);
});

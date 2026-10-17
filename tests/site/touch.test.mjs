// Touch gestures, fed as exact finger sequences with made-up times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TouchGestures, TOUCH } from '../../site/js/viewer/touch.js';

// Runs a script of [kind, id, x, y, t] steps (kind: down | move | up | tick | cancel); returns every action.
function play(g, steps) {
  const out = [];
  for (const [kind, id, x, y, t] of steps) {
    if (kind === 'tick') out.push(...g.tick(id));
    else if (kind === 'cancel') out.push(...g.cancel());
    else out.push(...g[kind](id, x, y, t));
  }
  return out;
}

test('tap → left click where the finger was', () => {
  const g = new TouchGestures();
  assert.deepEqual(play(g, [['down', 1, 100, 200, 0], ['up', 1, 101, 201, 80]]), [{ a: 'click', b: 0, n: 1, x: 100, y: 200 }]);
});

test('a small wobble is still a tap', () => {
  const g = new TouchGestures();
  const out = play(g, [['down', 1, 100, 200, 0], ['move', 1, 106, 205, 40], ['up', 1, 106, 205, 90]]);
  assert.deepEqual(out, [{ a: 'click', b: 0, n: 1, x: 100, y: 200 }]);
});

test('double tap → the second click carries count 2, at the first tap\'s spot', () => {
  const g = new TouchGestures();
  const out = play(g, [
    ['down', 1, 100, 200, 0], ['up', 1, 100, 200, 60],
    ['down', 2, 112, 210, 200], ['up', 2, 112, 210, 260],
  ]);
  assert.deepEqual(out, [{ a: 'click', b: 0, n: 1, x: 100, y: 200 }, { a: 'click', b: 0, n: 2, x: 100, y: 200 }]);
});

test('two taps far apart or too slow are two single clicks', () => {
  const g = new TouchGestures();
  const far = play(g, [['down', 1, 100, 200, 0], ['up', 1, 100, 200, 60], ['down', 2, 300, 200, 200], ['up', 2, 300, 200, 250]]);
  assert.deepEqual(far.map(a => a.n), [1, 1]);
  const g2 = new TouchGestures();
  const slow = play(g2, [['down', 1, 100, 200, 0], ['up', 1, 100, 200, 60], ['down', 2, 100, 200, 60 + TOUCH.DOUBLE_MS + 50], ['up', 2, 100, 200, 700]]);
  assert.deepEqual(slow.map(a => a.n), [1, 1]);
});

test('long press → right click while the finger is still down; lifting it then does nothing more', () => {
  const g = new TouchGestures();
  assert.deepEqual(play(g, [['down', 1, 50, 60, 1000]]), []);
  assert.equal(g.nextTimer(), 1000 + TOUCH.LONG_PRESS_MS);
  assert.deepEqual(play(g, [['tick', 1000 + TOUCH.LONG_PRESS_MS - 1]]), [], 'not yet');
  assert.deepEqual(play(g, [['tick', 1000 + TOUCH.LONG_PRESS_MS]]), [{ a: 'click', b: 2, n: 1, x: 50, y: 60 }]);
  assert.equal(g.nextTimer(), null);
  assert.deepEqual(play(g, [['move', 1, 200, 200, 1700], ['up', 1, 200, 200, 1800]]), []);
});

test('short hold then drag → left button down, drag moves, button up where the finger lifts', () => {
  const g = new TouchGestures();
  const out = play(g, [
    ['down', 1, 100, 100, 0],
    ['move', 1, 101, 100, 100],                 // still inside the slop
    ['move', 1, 140, 100, TOUCH.DRAG_HOLD_MS + 10],
    ['move', 1, 180, 120, TOUCH.DRAG_HOLD_MS + 40],
    ['up', 1, 180, 120, TOUCH.DRAG_HOLD_MS + 60],
  ]);
  assert.deepEqual(out, [
    { a: 'down', b: 0, x: 100, y: 100 },
    { a: 'drag', x: 140, y: 100 },
    { a: 'drag', x: 180, y: 120 },
    { a: 'up', b: 0, x: 180, y: 120 },
  ]);
});

test('moving straight away (no hold) only moves the pointer, no click', () => {
  const g = new TouchGestures();
  const out = play(g, [['down', 1, 100, 100, 0], ['move', 1, 130, 100, 50], ['move', 1, 160, 100, 80], ['up', 1, 160, 100, 120]]);
  assert.deepEqual(out, [{ a: 'move', x: 130, y: 100 }, { a: 'move', x: 160, y: 100 }]);
  assert.equal(g.nextTimer(), null);
});

test('two fingers moving together → scroll, page following the fingers', () => {
  const g = new TouchGestures();
  const out = play(g, [
    ['down', 1, 100, 300, 0], ['down', 2, 200, 300, 10],
    ['move', 1, 100, 280, 30], ['move', 2, 200, 280, 31],   // centre moved 20 px up: past the slop
    ['move', 1, 100, 250, 50], ['move', 2, 200, 250, 51],
    ['up', 1, 100, 250, 400], ['up', 2, 200, 250, 410],
  ]);
  const scrolls = out.filter(a => a.a === 'scroll');
  assert.ok(scrolls.length >= 2, JSON.stringify(out));
  const total = scrolls.reduce((s, a) => s + a.dy, 0);
  assert.equal(total, 50, 'fingers went up 50 px: the Mac scrolls by +50 (content moves up)');
  assert.ok(scrolls.every(a => a.dx === 0));
  assert.ok(!out.some(a => a.a === 'click'), 'no clicks from a scroll');
});

test('pinch → local zoom around the fingers, not a scroll', () => {
  const g = new TouchGestures();
  const out = play(g, [
    ['down', 1, 100, 300, 0], ['down', 2, 200, 300, 5],
    ['move', 1, 80, 300, 30], ['move', 2, 220, 300, 31],    // 100 → 140 apart
  ]);
  const zooms = out.filter(a => a.a === 'zoom');
  assert.ok(zooms.length >= 1, JSON.stringify(out));
  const factor = zooms.reduce((f, a) => f * a.factor, 1);
  assert.ok(Math.abs(factor - 1.4) < 1e-9, `zoomed by ${factor}`);
  assert.deepEqual([zooms.at(-1).cx, zooms.at(-1).cy], [150, 300]);
  assert.ok(!out.some(a => a.a === 'scroll'));
});

test('when zoomed in, two fingers move around the picture instead of scrolling the Mac', () => {
  const g = new TouchGestures({ isZoomed: () => true });
  const out = play(g, [
    ['down', 1, 100, 300, 0], ['down', 2, 200, 300, 5],
    ['move', 1, 130, 300, 30], ['move', 2, 230, 300, 31],
  ]);
  assert.ok(out.length > 0 && out.every(a => a.a === 'pan'), JSON.stringify(out));
  assert.equal(out.reduce((s, a) => s + a.dx, 0), 30);
});

test('two-finger double tap → back to the whole screen', () => {
  const g = new TouchGestures();
  const out = play(g, [
    ['down', 1, 100, 300, 0], ['down', 2, 200, 300, 5], ['up', 1, 100, 300, 90], ['up', 2, 200, 300, 95],
    ['down', 3, 100, 300, 200], ['down', 4, 200, 300, 205], ['up', 3, 100, 300, 280], ['up', 4, 200, 300, 285],
  ]);
  assert.deepEqual(out, [{ a: 'reset' }]);
});

test('a second finger during a drag lets go of the button first', () => {
  const g = new TouchGestures();
  const out = play(g, [
    ['down', 1, 100, 100, 0], ['move', 1, 150, 100, TOUCH.DRAG_HOLD_MS + 20], ['down', 2, 300, 100, TOUCH.DRAG_HOLD_MS + 40],
  ]);
  assert.deepEqual(out.at(-1), { a: 'up', b: 0, x: 150, y: 100 });
});

test('cancel (a system gesture took the touches) during a drag lets go of the button', () => {
  const g = new TouchGestures();
  const out = play(g, [['down', 1, 100, 100, 0], ['move', 1, 150, 100, TOUCH.DRAG_HOLD_MS + 20], ['cancel']]);
  assert.deepEqual(out.at(-1), { a: 'up', b: 0, x: 150, y: 100 });
  assert.deepEqual(play(g, [['down', 1, 10, 10, 2000], ['up', 1, 10, 10, 2050]]), [{ a: 'click', b: 0, n: 1, x: 10, y: 10 }],
    'and the next tap works normally');
});

test('a third finger is ignored until every finger is lifted', () => {
  const g = new TouchGestures();
  const out = play(g, [
    ['down', 1, 100, 300, 0], ['down', 2, 200, 300, 5], ['down', 3, 300, 300, 10],
    ['move', 1, 100, 200, 40], ['move', 2, 200, 200, 41], ['move', 3, 300, 200, 42],
    ['up', 1, 0, 0, 100], ['up', 2, 0, 0, 110], ['up', 3, 0, 0, 120],
  ]);
  assert.deepEqual(out, []);
  assert.deepEqual(play(g, [['down', 1, 10, 10, 1000], ['up', 1, 10, 10, 1050]]).length, 1);
});

test('a fast two-finger scroll with the fingers one above the other is still a scroll (one event per finger)', () => {
  // The first finger's move alone shrinks the gap by 30 px; only after the second finger's move is it clear that both
  // went up together.
  const g = new TouchGestures();
  const steps = [['down', 1, 200, 300, 0], ['down', 2, 200, 360, 5]];
  for (let i = 1, t = 20; i <= 4; i++, t += 16) {
    steps.push(['move', 1, 200, 300 - 30 * i, t], ['move', 2, 200, 360 - 30 * i, t + 1]);
  }
  const out = play(g, steps);
  assert.ok(out.length > 0 && out.every(a => a.a === 'scroll'), JSON.stringify(out));
  assert.equal(out.reduce((s, a) => s + a.dy, 0), 120);
});

test('a pinch with the thumb kept still is a pinch', () => {
  const g = new TouchGestures();
  const out = play(g, [
    ['down', 1, 100, 300, 0], ['down', 2, 160, 300, 5],
    ['move', 2, 180, 300, 20], ['move', 2, 200, 300, 36], ['move', 2, 220, 300, 52],
  ]);
  const zooms = out.filter(a => a.a === 'zoom');
  assert.ok(zooms.length >= 1 && !out.some(a => a.a === 'scroll'), JSON.stringify(out));
  assert.ok(Math.abs(zooms.reduce((f, a) => f * a.factor, 1) - 2) < 1e-9, 'gap 60 → 120 px');
});

// The display arrangement and the edge flip (site/js/viewer/displays.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangement, neighbour, entryPoint, edgeOf, EdgeFlip, EDGE_DWELL_MS, EDGE_PUSH } from '../../site/js/viewer/displays.js';

// A MacBook with an external display to its right, the external one higher up (as in System Settings › Displays), and
// a third one above the MacBook.
const BUILT_IN = { id: 1, name: 'Built-in Retina Display', x: 0, y: 0, width: 1512, height: 982, main: true };
const LG = { id: 2, name: 'LG UltraFine', x: 1512, y: -458, width: 2560, height: 1440, main: false };
const ABOVE = { id: 3, name: 'Sidecar', x: 200, y: -834, width: 1112, height: 834, main: false };
const DESK = [BUILT_IN, LG, ABOVE];

test('the display beyond each edge, from where the Mac says each one sits', () => {
  assert.equal(neighbour(DESK, BUILT_IN, 'right', 0.5)?.id, 2);
  assert.equal(neighbour(DESK, LG, 'left', 0.6)?.id, 1, 'level with the MacBook');
  assert.equal(neighbour(DESK, LG, 'left', 0.05), null, 'above the MacBook\'s top: nothing there');
  assert.equal(neighbour(DESK, BUILT_IN, 'top', 0.5)?.id, 3);
  assert.equal(neighbour(DESK, BUILT_IN, 'top', 0.02), null, 'the Sidecar starts further right');
  assert.equal(neighbour(DESK, ABOVE, 'bottom', 0.5)?.id, 1);
  assert.equal(neighbour(DESK, BUILT_IN, 'left', 0.5), null);
  assert.equal(neighbour(DESK, BUILT_IN, 'bottom', 0.5), null);
  assert.equal(neighbour([BUILT_IN], BUILT_IN, 'right', 0.5), null, 'one display: nowhere to go');
});

test('an older Mac that sends no positions: side by side in the order listed', () => {
  const plain = [{ id: 7, name: 'A', width: 1440, height: 900 }, { id: 9, name: 'B', width: 2560, height: 1440 }];
  assert.deepEqual(arrangement(plain).map(d => [d.x, d.y]), [[0, 0], [1440, 0]]);
  assert.equal(neighbour(plain, plain[0], 'right', 0.5)?.id, 9);
  assert.equal(neighbour(plain, plain[1], 'left', 0.5)?.id, 7);
  assert.equal(neighbour(plain, plain[0], 'top', 0.5), null);
});

test('coming in on the far side: level with where the pointer left', () => {
  // Leaving the MacBook's right edge halfway down (y = 491 points) is 949 points down the LG (top at -458).
  const e = entryPoint(DESK, BUILT_IN, LG, 'right', 0.5);
  assert.equal(e.x, 0);
  assert.ok(Math.abs(e.y - 949 / 1440) < 1e-9);
  const low = entryPoint(DESK, LG, BUILT_IN, 'left', 0.99);
  assert.equal(low.x, 1);
  assert.ok(Math.abs(low.y - (-458 + 0.99 * 1440) / 982) < 1e-9, 'level with it on the MacBook');
  assert.deepEqual(entryPoint(DESK, LG, BUILT_IN, 'left', 1.2), { x: 1, y: 1 }, 'clamped to the display');
  const up = entryPoint(DESK, BUILT_IN, ABOVE, 'top', 0.5);
  assert.equal(up.y, 1);
  assert.ok(Math.abs(up.x - (756 - 200) / 1112) < 1e-9);
});

test('which edge a position is on', () => {
  assert.equal(edgeOf({ x: 1, y: 0.4 }), 'right');
  assert.equal(edgeOf({ x: 0, y: 0.4 }), 'left');
  assert.equal(edgeOf({ x: 0.3, y: 0 }), 'top');
  assert.equal(edgeOf({ x: 0.3, y: 1 }), 'bottom');
  assert.equal(edgeOf({ x: 0.99, y: 0.5 }), null);
});

test('edge flip: resting at an edge with a display beyond it flips after the dwell, then waits until the pointer leaves', () => {
  let shown = BUILT_IN;
  const flip = new EdgeFlip((edge, along) => neighbour(DESK, shown, edge, along));
  assert.equal(flip.move({ x: 0.5, y: 0.5 }, 0), null);
  assert.equal(flip.move({ x: 0, y: 0.5 }, 10), null, 'nothing to the left');
  const r = flip.move({ x: 1, y: 0.5 }, 100);
  assert.equal(r.hint.target.id, 2);
  assert.equal(flip.tick(100 + EDGE_DWELL_MS - 1), null, 'not yet');
  const f = flip.tick(100 + EDGE_DWELL_MS);
  assert.equal(f.flip.target.id, 2);
  assert.equal(f.flip.edge, 'right');
  shown = LG;
  // Still at the right edge (an uncaptured pointer stays where it is): nothing more happens, even with time.
  assert.equal(flip.move({ x: 1, y: 0.5 }, 2000), null);
  assert.equal(flip.tick(5000), null);
  // Away from the edge and back to the left one: flips back.
  flip.move({ x: 0.5, y: 0.5 }, 5100);
  assert.equal(flip.move({ x: 0, y: 0.7 }, 5200).hint.target.id, 1);
  assert.equal(flip.tick(5200 + EDGE_DWELL_MS).flip.target.id, 1);
});

test('edge flip: leaving the edge before the dwell cancels it', () => {
  const flip = new EdgeFlip((edge, along) => neighbour(DESK, BUILT_IN, edge, along));
  flip.move({ x: 1, y: 0.5 }, 0);
  flip.move({ x: 0.9, y: 0.5 }, 200);
  assert.equal(flip.tick(EDGE_DWELL_MS + 1), null);
  flip.move({ x: 1, y: 0.5 }, 1000);
  flip.reset(); // the pointer left the picture
  assert.equal(flip.tick(5000), null);
});

test('edge flip: a captured mouse pushed on past the edge flips at once', () => {
  const flip = new EdgeFlip((edge, along) => neighbour(DESK, BUILT_IN, edge, along));
  assert.ok(flip.move({ x: 1, y: 0.5 }, 0, EDGE_PUSH / 2).hint);
  assert.equal(flip.move({ x: 1, y: 0.5 }, 16, EDGE_PUSH / 2).flip.target.id, 2);
});

// The keys bar's choices and touchpad swipes (site/js/viewer/shortcuts.js), and reaching the Mac's very edge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG, DEFAULT_BAR, FUNCTION_KEYS, makeCustom, cleanCustom, cleanBar, findShortcut, toggleOnBar, modLabel, SwipeDetector, SWIPE,
} from '../../site/js/viewer/shortcuts.js';
import { SHORTCUTS, SHIFT, CTRL, ALT, META } from '../../site/js/viewer/keys.js';
import { toDisplay } from '../../site/js/viewer/coords.js';

test('the catalog: unique ids, and the old bar keys press what they always pressed', () => {
  assert.equal(new Set(CATALOG.map(s => s.id)).size, CATALOG.length);
  for (const id of DEFAULT_BAR) {
    const s = findShortcut(id);
    assert.ok(s, id);
    if (SHORTCUTS[id]) assert.deepEqual({ code: s.code, key: s.key, m: s.m }, SHORTCUTS[id], id);
  }
  assert.deepEqual(FUNCTION_KEYS, Array.from({ length: 12 }, (_, i) => `f${i + 1}`));
  const fq = findShortcut('forceQuit');
  assert.deepEqual([fq.code, fq.m], ['Escape', META | ALT]);
});

test('homemade shortcuts: made from the editor, cleaned when loaded', () => {
  const c = makeCustom('KeyK', META | SHIFT);
  assert.equal(c.label, '⇧⌘K');
  assert.equal(c.id, 'c:⇧⌘KeyK');
  assert.equal(makeCustom('F5', 0, 'Present').title, 'Present (F5)');
  assert.equal(makeCustom('NoSuchKey', 0), null);
  assert.equal(makeCustom('KeyA', 99), null);
  const saved = [{ code: 'KeyK', m: META | SHIFT, name: '' }, { code: 'KeyK', m: META | SHIFT }, { code: 'Bad', m: 0 }, null, { code: 'F5', m: 0, name: 'Present' }];
  assert.deepEqual(cleanCustom(saved).map(s => s.label), ['⇧⌘K', 'Present']);
  assert.deepEqual(cleanCustom('junk'), []);
  assert.equal(modLabel(CTRL | ALT | SHIFT | META), '⌃⌥⇧⌘');
});

test('the bar: unknown ids and repeats dropped; turning a key on adds it at the end', () => {
  const own = cleanCustom([{ code: 'KeyK', m: META }]);
  assert.deepEqual(cleanBar(['esc', 'esc', 'nope', 'c:⌘KeyK', 42], own), ['esc', 'c:⌘KeyK']);
  assert.deepEqual(cleanBar(undefined), DEFAULT_BAR);
  assert.deepEqual(cleanBar([]), [], 'an empty bar is a choice');
  assert.deepEqual(toggleOnBar(['a', 'b'], 'a', true), ['b', 'a']);
  assert.deepEqual(toggleOnBar(['a', 'b'], 'a', false), ['b']);
});

test('touchpad: a clear sideways swipe fires once; up-and-down scrolling passes through', () => {
  const d = new SwipeDetector();
  assert.deepEqual(d.wheel(0, 30, 0), { pass: true });
  const r = [];
  for (let i = 0; i < 10; i++) r.push(d.wheel(40, 2, 1000 + i * 16));
  assert.equal(r.filter(x => x.swipe).length, 1, 'once');
  assert.equal(r.find(x => x.swipe).swipe, 1, 'scrolling right is "next"');
  assert.ok(r.every(x => !x.pass), 'swallowed');
  // After a pause, a new gesture.
  const t = 1000 + 10 * 16 + SWIPE.GAP_MS + 1;
  let left = null;
  for (let i = 0; i < 10 && !left; i++) left = d.wheel(-40, 0, t + i * 16).swipe || null;
  assert.equal(left, -1);
  assert.deepEqual(new SwipeDetector().wheel(10, 30, 0), { pass: true }, 'mostly down: scrolling');
});

test('the last page pixels at the picture edge reach the Mac\'s very edge (for the Dock)', () => {
  const box = { left: 0, top: 0, width: 1366, height: 768 };
  // A 1920×1080 Mac shown 1366×768: the page's last row is 767.
  assert.ok(toDisplay(683, 767, box, 1920, 1080).y < 1);
  assert.equal(toDisplay(683, 767, box, 1920, 1080, undefined, 2).y, 1);
  assert.equal(toDisplay(0.5, 400, box, 1920, 1080, undefined, 2).x, 0);
  assert.equal(toDisplay(683, 400, box, 1920, 1080, undefined, 2).y, toDisplay(683, 400, box, 1920, 1080).y, 'the middle is unchanged');
});

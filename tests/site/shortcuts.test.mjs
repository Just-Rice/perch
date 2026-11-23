// The Key deck's choices and touchpad swipes (site/js/viewer/shortcuts.js), and reaching the PC's very edge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG, DEFAULT_BAR, FUNCTION_KEYS, makeCustom, cleanCustom, cleanBar, findShortcut, toggleOnBar, modLabel, SwipeDetector, SWIPE,
  SWIPE_ACTIONS, GROUPS,
} from '../../site/js/viewer/shortcuts.js';
import { SHORTCUTS, SHIFT, CTRL, ALT, META } from '../../site/js/viewer/keys.js';
import { toDisplay } from '../../site/js/viewer/coords.js';

test('the catalog: unique ids, Windows shortcuts, and the deck\'s keys press what keys.js says', () => {
  assert.equal(new Set(CATALOG.map(s => s.id)).size, CATALOG.length);
  for (const id of DEFAULT_BAR) {
    const s = findShortcut(id);
    assert.ok(s, id);
    if (SHORTCUTS[id]) assert.deepEqual({ code: s.code, key: s.key, m: s.m }, SHORTCUTS[id], id);
  }
  assert.ok(CATALOG.every(s => GROUPS.includes(s.group)), 'every key in a group');
  assert.deepEqual(FUNCTION_KEYS, Array.from({ length: 12 }, (_, i) => `f${i + 1}`));
  // Ctrl+Alt+Del and Win+L can't be pressed by a program on Windows: Task Manager stands in, and there is no lock key.
  const tm = findShortcut('taskManager');
  assert.deepEqual([tm.code, tm.m], ['Escape', CTRL | SHIFT]);
  assert.ok(!CATALOG.some(s => s.code === 'KeyL' && s.m === META), 'no Win+L');
  assert.ok(!CATALOG.some(s => s.code === 'Delete' && s.m === (CTRL | ALT)), 'no Ctrl+Alt+Del');
  assert.deepEqual([findShortcut('snip').code, findShortcut('snip').m], ['KeyS', META | SHIFT], 'Snipping Tool');
  assert.deepEqual([findShortcut('showDesktop').code, findShortcut('showDesktop').m], ['KeyD', META]);
  // The only special keys are brightness (no sound, media or keyboard light keys on Windows).
  assert.deepEqual(CATALOG.filter(s => s.sys).map(s => s.sys), ['brightnessUp', 'brightnessDown']);
  // No Mac words or symbols left.
  assert.ok(!CATALOG.some(s => /⌘|⌥|⌃|Mission|Spotlight|Force Quit/.test(s.label + s.title)));
});

test('homemade shortcuts: made from the editor, cleaned when loaded', () => {
  const c = makeCustom('KeyK', META | SHIFT);
  assert.equal(c.label, 'Win+Shift+K');
  assert.equal(c.id, 'c:Win+Shift+KeyK');
  assert.equal(makeCustom('F5', 0, 'Present').title, 'Present (F5)');
  assert.equal(makeCustom('NoSuchKey', 0), null);
  assert.equal(makeCustom('KeyA', 99), null);
  const saved = [{ code: 'KeyK', m: META | SHIFT, name: '' }, { code: 'KeyK', m: META | SHIFT }, { code: 'Bad', m: 0 }, null, { code: 'F5', m: 0, name: 'Present' }];
  assert.deepEqual(cleanCustom(saved).map(s => s.label), ['Win+Shift+K', 'Present']);
  assert.deepEqual(cleanCustom('junk'), []);
  assert.equal(modLabel(CTRL | ALT | SHIFT | META), 'Win+Ctrl+Alt+Shift+');
});

test('the bar: unknown ids and repeats dropped; turning a key on adds it at the end', () => {
  const own = cleanCustom([{ code: 'KeyK', m: CTRL }]);
  assert.deepEqual(cleanBar(['esc', 'esc', 'nope', 'c:Ctrl+KeyK', 42], own), ['esc', 'c:Ctrl+KeyK']);
  assert.deepEqual(cleanBar(undefined), DEFAULT_BAR);
  assert.deepEqual(cleanBar([]), [], 'an empty bar is a choice');
  assert.deepEqual(toggleOnBar(['a', 'b'], 'a', true), ['b', 'a']);
  assert.deepEqual(toggleOnBar(['a', 'b'], 'a', false), ['b']);
});

test('swipes switch apps, virtual desktops or browser tabs, with Windows shortcuts', () => {
  assert.deepEqual(Object.keys(SWIPE_ACTIONS), ['apps', 'desktops', 'tabs', 'off']);
  for (const a of Object.values(SWIPE_ACTIONS)) {
    if (a.next) { assert.ok(findShortcut(a.next) && findShortcut(a.prev)); }
  }
  assert.equal(findShortcut(SWIPE_ACTIONS.desktops.next).m, META | CTRL);
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

test('the last page pixels at the picture edge reach the PC\'s very edge (for the taskbar)', () => {
  const box = { left: 0, top: 0, width: 1366, height: 768 };
  // A 1920×1080 PC shown 1366×768: the page's last row is 767.
  assert.ok(toDisplay(683, 767, box, 1920, 1080).y < 1);
  assert.equal(toDisplay(683, 767, box, 1920, 1080, undefined, 2).y, 1);
  assert.equal(toDisplay(0.5, 400, box, 1920, 1080, undefined, 2).x, 0);
  assert.equal(toDisplay(683, 400, box, 1920, 1080, undefined, 2).y, toDisplay(683, 400, box, 1920, 1080).y, 'the middle is unchanged');
});

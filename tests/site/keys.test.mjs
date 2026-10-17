// Key events → {t:"k"} messages, the Ctrl/⌘ swap, held-key bookkeeping, keys-bar presses and typed text.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHIFT, CTRL, ALT, META, modifierBits, keyMessage, HeldKeys, pressMessages, SHORTCUTS, charToKey, textMessages,
  isModifierCode,
} from '../../site/js/viewer/keys.js';

const ev = (type, code, key, mods = {}) => ({ type, code, key, keyCode: 0, isComposing: false, ...mods });

test('keyMessage: a plain letter, down and up', () => {
  assert.deepEqual(keyMessage(ev('keydown', 'KeyA', 'a')), { t: 'k', c: 'KeyA', k: 'a', d: true, m: 0 });
  assert.deepEqual(keyMessage(ev('keyup', 'KeyA', 'a')), { t: 'k', c: 'KeyA', k: 'a', d: false, m: 0 });
});

test('modifier bits follow the protocol: 1 shift, 2 ctrl, 4 alt, 8 meta', () => {
  assert.equal(modifierBits({ shiftKey: true }), 1);
  assert.equal(modifierBits({ ctrlKey: true }), 2);
  assert.equal(modifierBits({ altKey: true }), 4);
  assert.equal(modifierBits({ metaKey: true }), 8);
  assert.equal(modifierBits({ shiftKey: true, ctrlKey: true, altKey: true, metaKey: true }), 15);
  assert.equal(SHIFT | CTRL | ALT | META, 15);
  assert.deepEqual(keyMessage(ev('keydown', 'KeyZ', 'Z', { shiftKey: true, metaKey: true })),
    { t: 'k', c: 'KeyZ', k: 'Z', d: true, m: 9 });
});

test('Ctrl acts as ⌘: Control and Meta trade places, in code, key and bits', () => {
  const o = { swapCtrlCmd: true };
  assert.deepEqual(keyMessage(ev('keydown', 'ControlLeft', 'Control', { ctrlKey: true }), o),
    { t: 'k', c: 'MetaLeft', k: 'Meta', d: true, m: META });
  assert.deepEqual(keyMessage(ev('keydown', 'KeyC', 'c', { ctrlKey: true }), o),
    { t: 'k', c: 'KeyC', k: 'c', d: true, m: META }, 'Ctrl+C becomes ⌘C');
  assert.deepEqual(keyMessage(ev('keydown', 'MetaRight', 'Meta', { metaKey: true }), o),
    { t: 'k', c: 'ControlRight', k: 'Control', d: true, m: CTRL }, 'the Windows key becomes Control');
  assert.deepEqual(keyMessage(ev('keydown', 'KeyV', 'v', { ctrlKey: true, metaKey: true, shiftKey: true }), o).m,
    SHIFT | CTRL | META, 'both held: both stay held');
  assert.deepEqual(keyMessage(ev('keyup', 'ControlRight', 'Control'), o), { t: 'k', c: 'MetaRight', k: 'Meta', d: false, m: 0 });
});

test('without the swap, Ctrl stays Ctrl', () => {
  assert.deepEqual(keyMessage(ev('keydown', 'KeyC', 'c', { ctrlKey: true })), { t: 'k', c: 'KeyC', k: 'c', d: true, m: CTRL });
});

test('keyMessage ignores input-method keys and keys with no code', () => {
  assert.equal(keyMessage(ev('keydown', 'KeyA', 'a', { isComposing: true })), null);
  assert.equal(keyMessage(ev('keydown', 'KeyA', 'Process')), null);
  assert.equal(keyMessage({ ...ev('keydown', '', 'a'), keyCode: 229 }), null);
  assert.equal(keyMessage(ev('keydown', '', 'a')), null);
  assert.equal(keyMessage(ev('keydown', 'Unidentified', 'Unidentified')), null);
});

test('old Firefox "OS" codes are the Meta keys', () => {
  assert.equal(keyMessage(ev('keydown', 'OSLeft', 'OS', { metaKey: true })).c, 'MetaLeft');
  assert.equal(keyMessage(ev('keydown', 'OSRight', 'OS', { metaKey: true }), { swapCtrlCmd: true }).c, 'ControlRight');
});

test('HeldKeys: letting go of ⌘ lets go of keys macOS never reported going up', () => {
  const h = new HeldKeys();
  assert.equal(h.handle({ t: 'k', c: 'MetaLeft', k: 'Meta', d: true, m: 8 }).length, 1);
  assert.equal(h.handle({ t: 'k', c: 'KeyC', k: 'c', d: true, m: 8 }).length, 1);
  assert.equal(h.handle({ t: 'k', c: 'ShiftLeft', k: 'Shift', d: true, m: 9 }).length, 1);
  assert.equal(h.size, 3);
  const out = h.handle({ t: 'k', c: 'MetaLeft', k: 'Meta', d: false, m: 1 });
  assert.deepEqual(out, [
    { t: 'k', c: 'MetaLeft', k: 'Meta', d: false, m: 1 },
    { t: 'k', c: 'KeyC', k: 'c', d: false, m: 1 },
  ], 'C goes up with ⌘, Shift is still really held');
  assert.equal(h.size, 1);
});

test('HeldKeys: a key-up the Mac never saw go down is dropped; clear() forgets all', () => {
  const h = new HeldKeys();
  assert.deepEqual(h.handle({ t: 'k', c: 'KeyQ', k: 'q', d: false, m: 0 }), []);
  h.handle({ t: 'k', c: 'KeyQ', k: 'q', d: true, m: 0 });
  h.clear();
  assert.equal(h.size, 0);
  assert.deepEqual(h.handle({ t: 'k', c: 'KeyQ', k: 'q', d: false, m: 0 }), []);
});

test('pressMessages: ⌘Tab is ⌘ down, Tab down, Tab up, ⌘ up', () => {
  const s = SHORTCUTS.cmdTab;
  assert.deepEqual(pressMessages(s.code, s.key, s.m), [
    { t: 'k', c: 'MetaLeft', k: 'Meta', d: true, m: 8 },
    { t: 'k', c: 'Tab', k: 'Tab', d: true, m: 8 },
    { t: 'k', c: 'Tab', k: 'Tab', d: false, m: 8 },
    { t: 'k', c: 'MetaLeft', k: 'Meta', d: false, m: 0 },
  ]);
});

test('pressMessages: several modifiers go down in order and up in reverse', () => {
  const out = pressMessages('KeyZ', 'z', META | SHIFT);
  assert.deepEqual(out.map(m => `${m.c}${m.d ? '↓' : '↑'}${m.m}`),
    ['MetaLeft↓8', 'ShiftLeft↓9', 'KeyZ↓9', 'KeyZ↑9', 'ShiftLeft↑8', 'MetaLeft↑0']);
  assert.deepEqual(pressMessages('Escape', 'Escape').map(m => m.d), [true, false]);
});

test('keys bar shortcuts are the Mac ones', () => {
  assert.deepEqual(SHORTCUTS.missionControl, { code: 'ArrowUp', key: 'ArrowUp', m: CTRL });
  assert.deepEqual(SHORTCUTS.spotlight, { code: 'Space', key: ' ', m: META });
  assert.deepEqual(SHORTCUTS.cmdQ, { code: 'KeyQ', key: 'q', m: META });
  assert.deepEqual(SHORTCUTS.cmdW, { code: 'KeyW', key: 'w', m: META });
  assert.equal(SHORTCUTS.delete.code, 'Backspace');
  for (const k of ['esc', 'tab', 'left', 'up', 'down', 'right']) assert.ok(SHORTCUTS[k], k);
});

test('charToKey: US positions for shortcuts typed on a phone keyboard', () => {
  assert.deepEqual(charToKey('c'), { code: 'KeyC', key: 'c', shift: false });
  assert.deepEqual(charToKey('C'), { code: 'KeyC', key: 'C', shift: true });
  assert.deepEqual(charToKey('7'), { code: 'Digit7', key: '7', shift: false });
  assert.deepEqual(charToKey('@'), { code: 'Digit2', key: '@', shift: true });
  assert.deepEqual(charToKey('?'), { code: 'Slash', key: '?', shift: true });
  assert.deepEqual(charToKey(' '), { code: 'Space', key: ' ', shift: false });
  assert.deepEqual(charToKey('\n'), { code: 'Enter', key: 'Enter', shift: false });
  assert.equal(charToKey('é'), null);
  assert.equal(charToKey('ab'), null);
});

test('textMessages: at most 256 characters each, emoji never split', () => {
  assert.deepEqual(textMessages('hello'), [{ t: 'txt', s: 'hello' }]);
  assert.deepEqual(textMessages(''), []);
  const long = 'a'.repeat(255) + '😀' + 'b';
  const out = textMessages(long);
  assert.equal(out.length, 2);
  assert.equal(out[0].s, 'a'.repeat(255), 'the emoji (2 UTF-16 units) would not fit, so it starts the next piece');
  assert.equal(out[1].s, '😀b');
  assert.ok(out.every(m => m.s.length <= 256));
  assert.equal(textMessages('x'.repeat(600)).length, 3);
});

test('isModifierCode', () => {
  for (const c of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaRight', 'CapsLock']) assert.ok(isModifierCode(c), c);
  assert.equal(isModifierCode('KeyA'), false);
});

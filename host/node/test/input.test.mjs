// Every input message is checked before it can reach the app, which turns it into real mouse and keyboard events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, RateLimiter, MAX_TEXT_CHARS, MAX_SCROLL } from '../src/input.mjs';

test('pointer moves: only on the pointer channel, coordinates clamped to the screen, extra fields dropped', () => {
  assert.deepEqual(validateInput({ t: 'm', x: 0.25, y: 0.75, evil: 1 }, 'pointer'), { t: 'm', x: 0.25, y: 0.75 });
  assert.deepEqual(validateInput({ t: 'm', x: -3, y: 9 }, 'pointer'), { t: 'm', x: 0, y: 1 });
  assert.equal(validateInput({ t: 'm', x: 0.5, y: 0.5 }, 'input'), null, 'moves belong on the pointer channel');
  assert.equal(validateInput({ t: 'k', c: 'KeyA', d: true }, 'pointer'), null, 'keys never on the pointer channel');
  for (const bad of [{ t: 'm', x: '0.5', y: 0.5 }, { t: 'm', x: NaN, y: 0 }, { t: 'm', x: Infinity, y: 0 }, { t: 'm', x: 0.5 }]) {
    assert.equal(validateInput(bad, 'pointer'), null, JSON.stringify(bad));
  }
});

test('buttons, scrolling, keys, text and release are checked field by field', () => {
  assert.deepEqual(validateInput({ t: 'b', b: 0, d: true, x: 0.1, y: 0.2, n: 2 }, 'input'), { t: 'b', b: 0, d: true, x: 0.1, y: 0.2, n: 2 });
  assert.deepEqual(validateInput({ t: 'b', b: 2, d: false, x: 2, y: -1, n: 99 }, 'input'), { t: 'b', b: 2, d: false, x: 1, y: 0, n: 3 });
  assert.equal(validateInput({ t: 'b', b: 3, d: true, x: 0, y: 0 }, 'input'), null, 'only three buttons');
  assert.equal(validateInput({ t: 'b', b: 0, d: 'yes', x: 0, y: 0 }, 'input'), null);
  assert.equal(validateInput({ t: 'b', b: 0, d: true }, 'input'), null, 'buttons carry their own position');

  assert.deepEqual(validateInput({ t: 'w', dx: 0, dy: -120, x: 0.5, y: 0.5 }, 'input'), { t: 'w', dx: 0, dy: -120, x: 0.5, y: 0.5 });
  assert.deepEqual(validateInput({ t: 'w', dx: 1e9, dy: -1e9, x: 0.5, y: 0.5 }, 'input'), { t: 'w', dx: MAX_SCROLL, dy: -MAX_SCROLL, x: 0.5, y: 0.5 });
  assert.equal(validateInput({ t: 'w', dx: 0, dy: 0, x: 0.5, y: 0.5 }, 'input'), null, 'a scroll of nothing');

  assert.deepEqual(validateInput({ t: 'k', c: 'KeyA', k: 'a', d: true, m: 9 }, 'input'), { t: 'k', c: 'KeyA', k: 'a', d: true, m: 9 });
  assert.deepEqual(validateInput({ t: 'k', c: 'Enter', d: false, m: 255 }, 'input'), { t: 'k', c: 'Enter', k: '', d: false, m: 15 });
  for (const c of ['', 'Key A', 'Key-A', 'x'.repeat(33), 42, '../../etc']) {
    assert.equal(validateInput({ t: 'k', c, k: 'a', d: true, m: 0 }, 'input'), null, `code ${JSON.stringify(c)}`);
  }
  assert.equal(validateInput({ t: 'k', c: 'KeyA', k: 'a'.repeat(33), d: true }, 'input').k, '', 'over-long key text is dropped');

  assert.deepEqual(validateInput({ t: 'txt', s: 'héllo 👋\n' }, 'input'), { t: 'txt', s: 'héllo 👋\n' });
  assert.deepEqual(validateInput({ t: 'txt', s: 'a\u0000b\u001bc\u007f' }, 'input'), { t: 'txt', s: 'abc' }, 'control characters removed');
  assert.equal(validateInput({ t: 'txt', s: '\u0007' }, 'input'), null, 'nothing left');
  assert.ok(validateInput({ t: 'txt', s: '😀'.repeat(MAX_TEXT_CHARS) }, 'input'), '256 emoji is fine');
  assert.equal(validateInput({ t: 'txt', s: 'x'.repeat(MAX_TEXT_CHARS + 1) }, 'input'), null);

  assert.deepEqual(validateInput({ t: 'rel', junk: true }, 'input'), { t: 'rel' });
  for (const junk of [null, 7, 'k', [], { t: 'eval' }, { t: 'm', x: 0, y: 0 }, { t: '__proto__' }]) {
    assert.equal(validateInput(junk, 'input'), null, JSON.stringify(junk));
  }
  assert.equal(validateInput({ t: 'rel' }, 'control'), null, 'unknown channel');
});

test('rate limiter: bursts allowed, then the average rate', () => {
  let t = 0;
  const r = new RateLimiter({ rate: 10, burst: 5, now: () => t });
  let ok = 0;
  for (let i = 0; i < 20; i++) if (r.take()) ok++;
  assert.equal(ok, 5);
  t += 1000;
  ok = 0;
  for (let i = 0; i < 20; i++) if (r.take()) ok++;
  assert.equal(ok, 5, 'refills to the burst size, no more');
  t += 100;
  assert.equal(r.take(), true);
  assert.equal(r.take(), false);
});

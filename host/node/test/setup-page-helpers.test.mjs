// The Setup page's small pure helpers, run in Node (they only touch the DOM when called with it, and these don't):
// the password strength hint, the grouped setup key, the colour of an activity entry, the state pill and the times.
// Run: node --test test/setup-page-helpers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordStrength, MIN_LENGTH } from '../setup/lib/password.js';
import { minutesSeconds, ago, duration, toMs } from '../setup/lib/time.js';
import { groupSecret } from '../setup/sections/totp.js';
import { toneOf } from '../setup/sections/activity.js';
import { pillFor } from '../setup/sections/header.js';
import { suggestPassword } from '../src/names.mjs';

test('password strength: refuses short, guessable and name-based passwords; Perch\'s suggestion is strong', () => {
  assert.equal(MIN_LENGTH, 12);
  const level = (pw, name) => passwordStrength(pw, name).level;
  assert.equal(level(''), 'empty');
  assert.equal(passwordStrength('').ok, false);
  assert.equal(level('a'.repeat(11)), 'short');
  assert.match(passwordStrength('abcdefghij').text, /add 2 more characters/);
  assert.match(passwordStrength('abcdefghijk').text, /add 1 more character\./);
  assert.equal(level('🦜🦜🦜🦜🦜🦜🦜🦜🦜🦜🦜'), 'short', 'counts characters, not UTF-16 units');
  assert.equal(level('aaaaaaaaaaaaaaaa'), 'weak');
  assert.equal(level('ababababababab'), 'weak');
  assert.equal(level('1234567890123'), 'weak');
  assert.equal(level('qwertyuiop12'), 'weak');
  assert.equal(level('my-AMBER-otter-4821!', 'amber-otter-4821'), 'weak', 'the Mac\'s name is the username');
  assert.equal(level('correcthorse1'), 'ok');
  assert.equal(passwordStrength('correcthorse1').ok, true);
  assert.equal(level('Correct-Horse-9x'), 'strong');
  assert.equal(level('correct horse battery staple'), 'strong');
  for (let i = 0; i < 200; i++) {
    const pw = suggestPassword();
    assert.deepEqual([pw, level(pw, 'amber-otter-4821')], [pw, 'strong']);
  }
});

test('the setup key is shown in groups of four', () => {
  assert.equal(groupSecret('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'), 'ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567');
  assert.equal(groupSecret('ABCDEFGHIJ'), 'ABCD EFGH IJ');
  assert.equal(groupSecret(' AB CD '), 'ABCD');
  assert.equal(groupSecret(''), '');
});

test('activity colours go by kind, not by the words in a name', () => {
  const tone = (kind, text = '') => toneOf({ kind, text });
  assert.equal(tone('failure', 'Wrong 6-digit code from Chrome on Windows'), 'bad');
  assert.equal(tone('lockout', 'Passkey sign-in locked for 1 minute after 5 failed attempts'), 'bad');
  assert.equal(tone('sign-in', 'Signed in with a passkey: Safari on iPhone'), 'good');
  assert.equal(tone('pairing', 'New device paired: iPad'), 'good');
  assert.equal(tone('pairing', 'Pairing link cancelled after 3 wrong proofs'), 'bad');
  assert.equal(tone('settings', 'Mac renamed to amber-badger-1234'), 'neutral');
  assert.equal(tone('device', 'Removed Blockbuster laptop'), 'neutral');
  assert.equal(tone('session', 'Safari on iPhone disconnected (idle)'), 'neutral');
  assert.equal(tone(undefined, undefined), 'neutral');
});

test('the state pill says what Perch is doing, in plain words', () => {
  const pill = (state, extra = {}) => pillFor({ state, ...extra });
  assert.deepEqual(pill('ready'), ['Ready', 'good']);
  assert.deepEqual(pill('needs-setup'), ['Needs setup', 'warn']);
  assert.deepEqual(pill('paused'), ['Paused', 'warn']);
  assert.deepEqual(pill('offline'), ['Offline – can\'t reach the internet', 'bad']);
  assert.deepEqual(pill('starting'), ['Starting…', 'neutral']);
  assert.deepEqual(pill('error'), ['Something went wrong', 'bad']);
  assert.deepEqual(pill('connected', { session: { viewer: 'Safari on iPhone' } }), ['Connected to Safari on iPhone', 'live']);
  assert.deepEqual(pill('connected', { session: null }), ['Connected to a device', 'live']);
});

test('countdowns and friendly times', () => {
  assert.equal(minutesSeconds(600_000), '10:00');
  assert.equal(minutesSeconds(599_001), '10:00', 'rounded up, so it never shows 0:00 while still valid');
  assert.equal(minutesSeconds(598_999), '9:59');
  assert.equal(minutesSeconds(61_000), '1:01');
  assert.equal(minutesSeconds(1), '0:01');
  assert.equal(minutesSeconds(-5), '0:00');
  const now = Date.parse('2026-10-17T12:00:00Z');
  assert.equal(ago(now - 10_000, now), 'just now');
  assert.equal(ago(now - 60_000, now), '1 minute ago');
  assert.equal(ago(now - 5 * 60_000, now), '5 minutes ago');
  assert.equal(ago(now - 2 * 3600_000, now), '2 hours ago');
  assert.match(ago(now - 30 * 3600_000, now), /^(yesterday|\d+ \w+) at /);
  assert.equal(ago('not a date', now), '');
  assert.equal(duration(now - 20_000, now), 'less than a minute');
  assert.equal(duration(now - 25 * 60_000, now), '25 minutes');
  assert.equal(duration(now - 3 * 3600_000 - 5, now), '3 hours');
  assert.equal(toMs('2026-10-17T12:00:00Z'), now);
  assert.equal(toMs(new Date(now)), now);
  assert.ok(Number.isNaN(toMs(null)));
});

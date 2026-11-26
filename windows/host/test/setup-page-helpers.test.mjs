// The Control Center's small pure helpers, run in Node (they only touch the DOM when called with it, and these
// don't): the password strength hint, the grouped setup key, the colour of an activity entry, the state pill, the
// setup steps, "Control admin apps", the Windows version and the times.
// Run: node --test test/setup-page-helpers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordStrength, MIN_LENGTH } from '../setup/lib/password.js';
import { minutesSeconds, ago, duration, toMs } from '../setup/lib/time.js';
import { groupSecret } from '../setup/sections/totp.js';
import { toneOf } from '../setup/sections/activity.js';
import { pillFor, stateLine } from '../setup/sections/hero.js';
import { setupSteps } from '../setup/sections/home.js';
import { adminState } from '../setup/sections/admin.js';
import { windowsName } from '../setup/sections/about.js';
import { suggestPassword, newMacName } from '../src/names.mjs';
import * as setupNames from '../setup/lib/names.js';
import * as sharedNames from '../../site/js/shared/rendezvous.js';
import { ROUTE_WORDS as setupRouteWords } from '../setup/lib/route.js';
import { ROUTE_WORDS as sharedRouteWords } from '../../site/js/shared/route.js';

test('PC names: the Control Center’s copy of the rules is the website’s, and both kinds of name are accepted', () => {
  assert.equal(setupNames.CUSTOM_MAC_NAME_RE.source, sharedNames.CUSTOM_MAC_NAME_RE.source);
  for (const s of ['  Jordan MacBook ', 'room_204', 'A-B', 'x'.repeat(50)]) {
    assert.equal(setupNames.normalizeMacName(s), sharedNames.normalizeMacName(s), s);
  }
  const { isMacName, normalizeMacName } = sharedNames;
  for (let i = 0; i < 50; i++) assert.ok(isMacName(newMacName()), 'every made-up name');
  for (const ok of ['jordan-macbook', 'room204', 'mac1', 'a-b-c-d', 'x'.repeat(40)]) assert.ok(isMacName(ok), ok);
  assert.equal(normalizeMacName('  Jordan MacBook  '), 'jordan-macbook');
  for (const bad of ['abc', 'x'.repeat(41), 'my--mac', '-mac1', 'mac1-', 'my.mac', 'mäc1', 'my mac', '']) {
    assert.equal(isMacName(bad), false, JSON.stringify(bad));
  }
});

test('password strength: refuses short, guessable and name-based passwords; Roost\'s suggestion is strong', () => {
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
  assert.equal(level('my-AMBER-otter-4821!', 'amber-otter-4821'), 'weak', 'the PC\'s name is the username');
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

test('the state pill says what Roost is doing, in plain words', () => {
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

test('the hero\'s line under the state word doesn\'t repeat it', () => {
  assert.equal(stateLine({ state: 'paused', stateText: 'Paused: nobody can connect' }, 'Paused'), 'Nobody can connect');
  assert.equal(stateLine({ state: 'ready', stateText: 'Ready: open just-rice.github.io/roost to connect' }, 'Ready'),
    'Open just-rice.github.io/roost to connect');
  assert.equal(stateLine({ state: 'needs-setup', stateText: 'Finish setting up: add Roost to your authenticator app' }, 'Needs setup'),
    'Finish setting up: add Roost to your authenticator app');
  assert.equal(stateLine({ state: 'offline', stateText: 'Offline' }, 'Offline'), '');
  assert.equal(stateLine({ state: 'connected', stateText: 'Safari on iPhone is connected' }, 'Connected'), '', 'the session line says it');
  assert.equal(stateLine({ state: 'ready' }, 'Ready'), '');
});

test('the setup steps: authenticator app, a device, then the optional relay and admin control', () => {
  const win = { os: 'windows', elevated: false, elevatedTask: false, features: {} };
  const steps = (st) => Object.fromEntries(setupSteps(st).map(s => [s.id, s]));
  let s = steps({ app: win, totp: { set: false }, devices: [], settings: {} });
  assert.deepEqual([s.totp.done, s.pair.done, s.pair.locked, s.relay.done, s.admin.done, s.admin.hidden], [false, false, true, false, false, false]);
  assert.equal(s.relay.optional && s.admin.optional, true);
  s = steps({ app: win, totp: { set: true }, devices: [{ id: 'a' }], relay: { set: false }, workerRelay: { set: true }, settings: {} });
  assert.deepEqual([s.totp.done, s.pair.done, s.pair.locked, s.relay.done], [true, true, false, true]);
  // Every 6-digit code switched off: the authenticator step counts as done (skipped), and pairing isn't locked.
  const off = { codeWithPasskey: false, codeWithBackup: false, codeWithPairing: false };
  s = steps({ app: win, totp: { set: false }, devices: [], settings: off });
  assert.deepEqual([s.totp.done, s.totp.skipped, s.pair.locked], [true, true, false]);
  // Admin control: done with the task (or running elevated); only offered on Windows, once the app has said so.
  assert.equal(steps({ app: { ...win, elevatedTask: true } }).admin.done, true);
  assert.equal(steps({ app: { ...win, elevated: true } }).admin.done, true);
  assert.equal(steps({ app: { ...win, os: 'macos' } }).admin.hidden, true);
  assert.equal(steps({ app: { os: null } }).admin.hidden, true);
  assert.equal(steps({}).admin.hidden, true);
});

test('Control admin apps: what the card says in each state', () => {
  const win = { os: 'windows', elevated: false, elevatedTask: false };
  const a = (app, asked) => { const r = adminState(app, asked); return [r.chip, r.tone, r.available]; };
  assert.deepEqual(a(null), ['Unknown', 'neutral', false]);
  assert.deepEqual(a({ os: null }), ['Unknown', 'neutral', false]);
  assert.deepEqual(a({ ...win, os: 'macos' }), ['Not needed', 'neutral', false]);
  assert.deepEqual(a(win), ['Off', 'neutral', true]);
  assert.deepEqual(a(win, true), ['Waiting for you', 'warn', true]);
  assert.deepEqual(a({ ...win, elevatedTask: true }, false), ['Turning off…', 'warn', true]);
  assert.deepEqual(a({ ...win, elevatedTask: true, elevated: true }), ['On', 'good', true]);
  assert.deepEqual(a({ ...win, elevatedTask: true }), ['Almost on', 'warn', true]);
  assert.deepEqual(a({ ...win, elevated: true }), ['On for now', 'good', true]);
  assert.match(adminState(win).status, /prompts/);
});

test('Windows versions in words', () => {
  assert.equal(windowsName('10.0.22631'), 'Windows 11 (build 22631)');
  assert.equal(windowsName('10.0.22000'), 'Windows 11 (build 22000)');
  assert.equal(windowsName('10.0.19045'), 'Windows 10 (build 19045)');
  assert.equal(windowsName('15.1'), '15.1');
  assert.equal(windowsName(null), '');
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

test('the Control Center names the connection route exactly as the website does', () => {
  assert.deepEqual({ ...setupRouteWords }, { ...sharedRouteWords });
});

test('the Control Center\'s ember background is the website\'s, unchanged', async () => {
  const { readFile } = await import('node:fs/promises');
  const here = new URL('.', import.meta.url);
  const setupCopy = await readFile(new URL('../setup/lib/ember.js', here), 'utf8');
  const site = await readFile(new URL('../../site/js/shared/ember.js', here), 'utf8');
  assert.equal(setupCopy, site, 'copy site/js/shared/ember.js to host/setup/lib/ember.js');
});

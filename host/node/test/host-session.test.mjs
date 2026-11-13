// Whole sessions through the real host process: src/main.mjs runs as a child of test/fake-app.mjs (standing in for
// the Swift app, playing the committed fixtures) and test/soft-viewer.mjs plays the website, with werift as its
// WebRTC and a software passkey. Everything goes through the local test broker (tests/e2e/broker.mjs), never the
// public ones, and nothing touches the real screen, keyboard or Keychain.
//
// What these check, above all: no picture, no sound and no input before a viewer has signed in over this exact
// connection, and every sign-in proof fails when an SDP was changed on the way.
import { fingerprintBytes, sdpFingerprint } from '../../../site/js/shared/bind.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import { startBroker } from '../../../tests/e2e/broker.mjs';
import { fromB64url, randomBytes } from '../../../site/js/shared/bytes.js';
import { startHost, TEST_ORIGIN, TEST_RP_ID, TEST_SITE } from './fake-app.mjs';
import { SoftViewer, Refused, parsePairLink } from './soft-viewer.mjs';
import { SoftAuthenticator } from './soft-authenticator.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

let broker;
before(async () => { broker = await startBroker(); });
after(async () => { await broker?.close(); });

// --- helpers ---

// A host for one test, stopped (and its home removed) when the test ends.
async function host(t, opts = {}) {
  const app = await startHost({ broker: broker.url, ...opts });
  t.after(() => app.stop());
  return app;
}

function viewer(t, opts = {}) {
  const v = new SoftViewer({ brokers: [broker.url], ...opts });
  t.after(() => v.close());
  return v;
}

const authenticator = () => new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN });

// The Mac's address as a synced passkey carries it, read straight from the test home (file secrets in test mode).
function identity(app) {
  const cfg = JSON.parse(readFileSync(join(app.home, 'config.json'), 'utf8'));
  const sec = JSON.parse(readFileSync(join(app.home, 'secrets.json'), 'utf8'));
  return { hostId: fromB64url(cfg.hostId), sigKey: fromB64url(sec.sigKey), macName: cfg.macName, config: cfg };
}

// A code that is wrong for the host's current window (previous, current and next step).
function wrongCode(app) {
  const valid = new Set([-30_000, 0, 30_000].map(o => app.code(o)));
  for (let n = Number(app.code()) + 1; ; n += 7919) {
    const c = String(n % 1_000_000).padStart(6, '0');
    if (!valid.has(c)) return c;
  }
}

// Pairs a new soft viewer through a fresh pairing link, the way the website does. Returns the signed-in viewer.
async function pair(t, app, { authn = authenticator(), label = 'Soft viewer', beforeCode } = {}) {
  const { link } = await app.call('pairStart');
  const p = parsePairLink(link);
  const v = viewer(t, { authenticator: authn, label });
  await v.open({ route: 'pair', hostId: p.hostId, sigKey: p.sigKey, pairId: p.pairId });
  const end = await v.signInPair({ pairId: p.pairId, pairSecret: p.pairSecret, code: () => app.freshCode(), beforeCode });
  return { v, end, authn, link, p };
}

// A host with the authenticator app set up and one paired passkey; the pairing viewer has already left.
async function pairedHost(t, opts = {}) {
  const app = await host(t, opts);
  await app.setupTotp();
  const { v, end, authn } = await pair(t, app);
  assert.equal(end.t, 'ready', `pairing failed: ${JSON.stringify(end)}`);
  const credentialId = v.credentialId;
  v.send({ t: 'bye' });
  await app.waitFor(async () => (await app.call('state')).session === null, { what: 'the pairing viewer to leave' });
  await v.close();
  return { app, authn, credentialId, ...identity(app) };
}

// Opens a passkey session and signs in. Returns {v, end}.
async function passkey(t, ctx, { label = 'Passkey viewer', code, overrides, beforeCode, authn = ctx.authn } = {}) {
  const v = viewer(t, { authenticator: authn, label });
  await v.open({ route: 'passkey', hostId: ctx.hostId, sigKey: ctx.sigKey });
  const end = await v.signInPasskey({ credentialId: ctx.credentialId, code: code ?? (() => ctx.app.freshCode()), overrides, beforeCode });
  return { v, end };
}

async function setBackupPassword(app, password) {
  await opaque.ready;
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });
  const { registrationResponse } = await app.call('backupRegisterStart', registrationRequest);
  const { registrationRecord } = opaque.client.finishRegistration({ clientRegistrationState, registrationResponse, password });
  return app.call('backupRegisterFinish', registrationRecord);
}

// The next control message of this type that satisfies `pred` (earlier ones, such as periodic status, are skipped).
async function nextWhere(v, type, pred, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const m = await v.next([type], Math.max(1, timeoutMs - (Date.now() - t0)));
    if (pred(m)) return m;
  }
}

async function refusal(promise) {
  try {
    await promise;
  } catch (e) {
    if (e instanceof Refused) return e.msg;
    throw e;
  }
  assert.fail('expected the Mac to refuse');
}

// Every SDP change, however harmless, changes the binding. This one bumps the session id in the o= line.
const bumpOrigin = sdp => sdp.replace(/^o=(\S+) (\d+)/m, (_, user, id) => `o=${user} ${BigInt(id) + 1n}`);

const ALL_INPUTS = [
  { t: 'b', b: 0, d: true, x: 0.25, y: 0.5, n: 1 },
  { t: 'b', b: 0, d: false, x: 0.25, y: 0.5, n: 1 },
  { t: 'w', dx: 0, dy: -120, x: 0.5, y: 0.5 },
  { t: 'k', c: 'KeyA', k: 'a', d: true, m: 8 },
  { t: 'k', c: 'KeyA', k: 'a', d: false, m: 8 },
  { t: 'txt', s: 'héllo 👋' },
  { t: 'rel' },
];

// --- before setup ---

test('before setup every hello is refused, and an old viewer is told to reload', async (t) => {
  const app = await host(t);
  const id = identity(app);
  const st = await app.call('state');
  assert.equal(st.state, 'needs-setup');
  assert.equal(st.test, true);

  const old = await refusal(viewer(t).open({ route: 'passkey', hostId: id.hostId, sigKey: id.sigKey, pv: 0 }));
  assert.deepEqual({ reason: old.reason, pv: old.pv, minPv: old.minPv, hv: old.hv }, { reason: 'version', pv: 1, minPv: 1, hv: '1.2.3' });

  const r1 = await refusal(viewer(t).open({ route: 'passkey', hostId: id.hostId, sigKey: id.sigKey }));
  assert.equal(r1.reason, 'not-set-up');

  // An authenticator app alone is not enough for passkey sign-in: there is no passkey yet.
  await app.setupTotp();
  const r2 = await refusal(viewer(t).open({ route: 'passkey', hostId: id.hostId, sigKey: id.sigKey }));
  assert.equal(r2.reason, 'not-set-up');
  assert.equal((await app.call('state')).stateText, 'Finish setting up: pair a phone or computer');
});

test('with no broker reachable the Mac shows offline, and comes online when one appears', async (t) => {
  // A port that was just free: nothing listens there until the broker below starts on it.
  const probe = await startBroker();
  const port = Number(new URL(probe.url).port);
  await probe.close();
  const app = await startHost({ broker: `ws://127.0.0.1:${port}/mqtt`, online: false });
  t.after(() => app.stop());
  const st = await app.call('state');
  assert.equal(st.state, 'offline');
  assert.match(st.stateText, /^Offline/);
  await app.waitForCommand(c => c.c === 'status' && c.state === 'offline');

  const late = await startBroker({ port });
  t.after(() => late.close());
  await app.waitFor(async () => (await app.call('state')).state === 'needs-setup', { timeoutMs: 15000, what: 'reconnecting' });
  await app.waitForCommand(c => c.c === 'status' && c.state === 'needs-setup');
});

// --- pairing ---

test('pairing: nothing is sent and no input reaches the app until the code is right; then picture, sound and input', async (t) => {
  // The fake app streams the whole time, so frames are reaching the host long before anyone signs in.
  const app = await host(t, { streamAlways: true });
  const firstRun = await app.waitForCommand(c => c.c === 'open-url');
  assert.match(firstRun.url, /^http:\/\/127\.0\.0\.1:\d+\/\?k=/, 'Setup opens on the first run');
  assert.ok(await app.waitForCommand(c => c.c === 'keep-awake' && c.on === true), 'keep-awake applied after HELLO');
  assert.ok(app.commands.some(c => c.c === 'login-item' && c.on === true), 'login item applied after HELLO');

  await app.setupTotp();
  await assert.rejects(app.call('totpConfirm', '123456'), /Start setting up/);
  const { link, expiresAt } = await app.call('pairStart');
  assert.ok(link.startsWith(`${TEST_SITE}#pair=`));
  assert.ok(Math.abs(Date.parse(expiresAt) - (Date.now() + app.clockOffset) - 10 * 60_000) < 5000);
  assert.equal((await app.call('state')).pairing.link, link);

  const p = parsePairLink(link);
  const authn = authenticator();
  const v = viewer(t, { authenticator: authn, label: 'Safari on iPhone' });
  const hi = await v.open({ route: 'pair', hostId: p.hostId, sigKey: p.sigKey, pairId: p.pairId });
  assert.equal(hi.route, 'pair');
  assert.equal(hi.pv, 1);
  assert.equal(fromB64url(hi.nonce).length, 32);
  assert.equal(hi.name, identity(app).macName);

  let codeSentAt = 0;
  const end = await v.signInPair({
    pairId: p.pairId, pairSecret: p.pairSecret,
    code: async () => { const c = await app.freshCode(); codeSentAt = Date.now(); return c; },
    beforeCode: async () => {
      // Every check but the code has passed. Input on both channels, and some time for media to leak if it would.
      v.sendPointer({ t: 'm', x: 0.5, y: 0.5 });
      for (const ev of ALL_INPUTS) v.sendInput(ev);
      await sleep(600);
      assert.equal(v.media.video, 0, 'no video before sign-in');
      assert.equal(v.media.audio, 0, 'no audio before sign-in');
      assert.equal(app.inputs.length, 0, 'no input before sign-in');
      const dbg = await app.call('debug');
      assert.ok(dbg.sessions[0].stats.inputDroppedBeforeSignIn >= ALL_INPUTS.length);
    },
  });
  assert.equal(end.t, 'ready', JSON.stringify(end));

  // The pairing options followed the protocol and were made for this connection.
  const o = v.pairOptions;
  assert.equal(o.challenge, Buffer.from(v.bind).toString('base64url'));
  assert.deepEqual(o.rp, { id: TEST_RP_ID, name: 'Perch' });
  assert.equal(o.user.name, `Perch · ${hi.name}`);
  assert.equal(o.authenticatorSelection.userVerification, 'required');
  assert.equal(o.authenticatorSelection.residentKey, 'required');
  // hostId ‖ sigKey ‖ a 16-byte pin of the Mac's fixed DTLS certificate: the fingerprint in the Mac's offer.
  const handle = Buffer.from(o.user.id, 'base64url');
  assert.equal(handle.length, 64);
  assert.deepEqual([...handle.subarray(48)], [...fingerprintBytes(sdpFingerprint(v.offerSdp))]);

  assert.equal(v.paired.name, hi.name);
  assert.equal(v.paired.credentialId, v.credentialId);
  assert.equal(end.input, true);
  assert.equal(end.quality, 'balanced');
  assert.deepEqual(end.display, { id: 1, width: 1512, height: 982 });
  assert.equal(end.displays.length, 2);

  // Media now flows, starting with a keyframe that carries its parameter sets.
  const m = await v.waitForMedia(x => x.frames >= 10 && x.audio >= 20);
  assert.ok(m.firstVideoAt >= codeSentAt && m.firstAudioAt >= codeSentAt, 'media only after the code');
  assert.deepEqual(m.firstFrameNals.filter(n => n !== 6), [7, 8, 5], 'first frame is SPS, PPS, IDR');
  assert.ok(m.keyframesWithParams >= 1);

  // Input sent before sign-in was dropped, not queued; input now reaches the app, checked and unchanged.
  v.sendPointer({ t: 'm', x: 2, y: -1, extra: 'dropped' });
  for (const ev of ALL_INPUTS) v.sendInput(ev);
  v.sendInput({ t: 'k', c: 'Key A!', k: 'a', d: true });     // bad code: dropped
  v.sendInput({ t: 'eval', s: 'rm -rf /' });                  // unknown type: dropped
  v.sendInput('not json');
  await app.waitFor(() => app.inputs.length >= ALL_INPUTS.length + 1, { what: 'input at the app' });
  await sleep(200);
  const got = app.inputs.map(i => i.ev);
  // The two channels are independent, so only the order within each one is promised.
  assert.deepEqual(got.filter(e => e.t === 'm'), [{ t: 'm', x: 1, y: 0 }], 'pointer clamped and extra fields dropped');
  assert.deepEqual(got.filter(e => e.t !== 'm'), ALL_INPUTS);
  assert.deepEqual(await app.call('testInputEcho'), got, 'the app echoed exactly what it was given');

  // Session messages.
  v.send({ t: 'ping', n: 7, ts: 1234.5 });
  assert.deepEqual(await v.next(['pong']), { t: 'pong', n: 7, ts: 1234.5 });
  // The first status may come early (capture started) with nothing measured yet; the periodic one has rates.
  const early = await v.next(['status'], 5000);
  assert.equal(early.width, 640);
  const status = await nextWhere(v, 'status', m => m.kbps > 0);
  assert.equal(status.link, 'good');
  assert.equal(status.input, true);
  assert.equal(status.width, 640);
  assert.ok(status.kbps > 0 && status.fps > 0, JSON.stringify(status));

  const st = await app.call('state');
  assert.equal(st.state, 'connected');
  assert.equal(st.session.viewer, 'Safari on iPhone');
  assert.equal(st.session.route, 'pair');
  assert.equal(st.session.deviceId, v.credentialId);
  assert.equal(st.pairing, null, 'the link is used up');
  assert.deepEqual(st.devices.map(d => d.label), ['Safari on iPhone']);
  const kinds = st.activity.map(a => a.kind);
  for (const k of ['pairing', 'sign-in']) assert.ok(kinds.includes(k), `activity has ${k}`);
  const sessionCmd = app.commands.find(c => c.c === 'session' && c.active);
  assert.deepEqual({ viewer: sessionCmd.viewer, route: sessionCmd.route }, { viewer: 'Safari on iPhone', route: 'pair' });
  const cap = app.commands.find(c => c.c === 'capture' && c.on);
  assert.deepEqual(cap, { ...cap, display: 1, maxEdge: 1920, fps: 30, kbps: 5000, audio: true });

  // The same link can't pair anything else.
  const again = viewer(t, { authenticator: authenticator() });
  await again.open({ route: 'pair', hostId: p.hostId, sigKey: p.sigKey, pairId: p.pairId });
  const no = await again.signInPair({ pairId: p.pairId, pairSecret: p.pairSecret, code: () => app.freshCode() });
  assert.deepEqual([no.t, no.reason, no.final], ['denied', 'bad-link', true]);
  assert.equal((await app.call('state')).devices.length, 1);

  // The viewer leaving stops capture and the session light.
  const since = app.commands.length;
  v.send({ t: 'bye' });
  await app.waitForCommand(c => c.c === 'capture' && c.on === false, { since });
  await app.waitForCommand(c => c.c === 'session' && c.active === false, { since });
  await app.waitForCommand(c => c.c === 'status' && c.state === 'ready', { since });
});

test('pairing: three wrong proofs burn the link, and a cancelled link stops working', async (t) => {
  const app = await host(t);
  await app.setupTotp();
  const { link } = await app.call('pairStart');
  const p = parsePairLink(link);
  for (let i = 0; i < 3; i++) {
    const v = viewer(t, { authenticator: authenticator() });
    await v.open({ route: 'pair', hostId: p.hostId, sigKey: p.sigKey, pairId: p.pairId });
    const end = await v.signInPair({ pairId: p.pairId, pairSecret: new Uint8Array(32), code: '000000' });
    assert.equal(end.reason, 'bad-link');
  }
  assert.equal((await app.call('state')).pairing, null, 'burnt');
  const v = viewer(t, { authenticator: authenticator() });
  await v.open({ route: 'pair', hostId: p.hostId, sigKey: p.sigKey, pairId: p.pairId });
  assert.equal((await v.signInPair({ pairId: p.pairId, pairSecret: p.pairSecret, code: () => app.freshCode() })).reason, 'bad-link');

  const second = parsePairLink((await app.call('pairStart')).link);
  await app.call('pairCancel');
  const w = viewer(t, { authenticator: authenticator() });
  await w.open({ route: 'pair', hostId: second.hostId, sigKey: second.sigKey, pairId: second.pairId });
  assert.equal((await w.signInPair({ pairId: second.pairId, pairSecret: second.pairSecret, code: () => app.freshCode() })).reason, 'bad-link');
  assert.equal((await app.call('state')).devices.length, 0);
});

// --- passkey sign-in ---

test('passkey sign-in: a wrong code can be retried, each code works once, and a new sign-in takes over', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  const before = identity(app).config.devices[0];

  let used = null;
  const first = await passkey(t, ctx, {
    label: 'Chrome on Mac',
    code: [wrongCode(app), async () => (used = await app.freshCode())],
  });
  assert.equal(first.end.t, 'ready', JSON.stringify(first.end));
  assert.deepEqual(first.v.all.filter(m => m.t === 'denied').map(m => [m.reason, m.final]), [['wrong-code', false]]);
  await first.v.waitForMedia(m => m.keyframes >= 1);

  // The counter the passkey sent is saved, and the device shows when it was last used.
  const after = identity(app).config.devices[0];
  assert.ok(after.counter > before.counter, `counter ${before.counter} → ${after.counter}`);
  assert.ok(after.lastUsedAt);

  // The same code again (someone who watched it being typed) is refused.
  const replay = await passkey(t, ctx, { label: 'Replay', code: [used, used, used] });
  assert.deepEqual([replay.end.t, replay.end.reason], ['denied', 'wrong-code']);
  assert.equal((await app.call('state')).session.viewer, 'Chrome on Mac', 'the first viewer is still the one');

  // A second device signing in takes over; the first is told why.
  const second = await passkey(t, ctx, { label: 'Firefox on Windows' });
  assert.equal(second.end.t, 'ready');
  const bye = await first.v.next(['bye']);
  assert.equal(bye.reason, 'signed-in-elsewhere');
  const before2 = second.v.media.frames;
  await second.v.waitForMedia(m => m.frames >= before2 + 5 && m.keyframesWithParams >= 1);
  const st = await app.call('state');
  assert.equal(st.session.viewer, 'Firefox on Windows');
  assert.equal(st.session.route, 'passkey');
  assert.equal(st.session.deviceId, ctx.credentialId);
});

test('bad passkeys never lock anyone out; five wrong codes lock the passkey route (not pairing) until the lock runs out', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;

  // A passkey this Mac never paired, and one made inside another page's frame: refused, and NOT counted. Anyone with
  // the rendezvous key (an old pairing link, a removed device) could otherwise lock the owner out with rubbish.
  const stranger = authenticator();
  stranger.create({ challenge: 'AAAA', rp: { id: TEST_RP_ID }, user: { id: Buffer.from(ctx.hostId).toString('base64url') } });
  for (let i = 0; i < 6; i++) {
    const u = viewer(t, { authenticator: stranger });
    await u.open({ route: 'passkey', hostId: ctx.hostId, sigKey: ctx.sigKey });
    assert.equal((await u.signInPasskey({ code: '000000' })).reason, 'unknown-device');
    await u.close();
  }
  const framed = await passkey(t, ctx, { overrides: { topOrigin: 'https://evil.example' }, code: '000000' });
  assert.deepEqual([framed.end.reason, framed.end.final], ['bad-passkey', true]);
  assert.deepEqual((await app.call('debug')).limits.passkey, { fails: 0, lockedUntil: 0 }, 'nothing counted');

  // A right passkey but wrong codes: these count. Three in one session (it then ends), two more in the next.
  const first = await passkey(t, ctx, { code: [wrongCode(app), wrongCode(app), wrongCode(app)] });
  assert.equal(first.end.reason, 'wrong-code');
  const second = await passkey(t, ctx, { code: [wrongCode(app), wrongCode(app)] });
  assert.equal(second.end.reason, 'locked-out');
  assert.equal(second.end.retryAfter, 60);
  assert.equal(second.end.final, true);

  // While locked, passkey hellos are refused before any WebRTC is set up; pairing has its own counter and still works.
  const locked = await refusal(viewer(t).open({ route: 'passkey', hostId: ctx.hostId, sigKey: ctx.sigKey }));
  assert.equal(locked.reason, 'locked-out');
  assert.ok(locked.retryAfter > 50 && locked.retryAfter <= 60);
  await app.call('pairStart');
  const pairer = viewer(t);
  await pairer.open({ route: 'pair', hostId: ctx.hostId, sigKey: ctx.sigKey, pairId: new Uint8Array(16) });
  await pairer.close();

  const st = await app.call('state');
  assert.ok(st.activity.some(a => a.kind === 'lockout' && /Passkey sign-in locked for 1 minute/.test(a.text)), JSON.stringify(st.activity));

  // A minute later it opens again, and a success clears the count.
  await app.advance(61_000);
  const ok = await passkey(t, ctx);
  assert.equal(ok.end.t, 'ready', JSON.stringify(ok.end));
  assert.deepEqual((await app.call('debug')).limits.passkey, { fails: 0, lockedUntil: 0 });
});

// --- backup sign-in ---

test('backup sign-in: wrong password, right password and code; its lockout leaves passkeys alone', async (t) => {
  const ctx = await pairedHost(t);
  const { app, macName } = ctx;
  const password = (await app.call('suggestPassword'));
  assert.match(password, /^[a-z]+(-[a-z]+){4}$/);

  // Off until a password is set; the name topic isn't even listened to.
  await assert.rejects(app.call('updateSettings', { backupOn: true }), /backup password first/);
  await assert.rejects(viewer(t).open({ route: 'backup', macName, timeoutMs: 1500 }), /no offer/);

  await setBackupPassword(app, password);
  let st = await app.call('state');
  assert.deepEqual([st.backup.set, st.backup.on, st.settings.backupOn], [true, true, true]);

  const right = viewer(t, { label: 'Library computer' });
  const hi = await right.open({ route: 'backup', macName: macName.toUpperCase() });
  assert.equal(hi.route, 'backup');
  const end = await right.signInBackup({ password, code: () => app.freshCode() });
  assert.equal(end.t, 'ready', JSON.stringify(end));
  await right.waitForMedia(m => m.keyframes >= 1 && m.audio > 5);
  st = await app.call('state');
  assert.equal(st.session.route, 'backup');
  assert.equal(st.session.deviceId, null);
  assert.ok(st.activity.some(a => a.kind === 'sign-in' && /backup password/.test(a.text)));
  right.send({ t: 'bye' });

  // Five wrong passwords lock backup sign-in; the owner's passkey still works.
  for (let i = 0; i < 5; i++) {
    const v = viewer(t);
    await v.open({ route: 'backup', macName });
    const r = await v.signInBackup({ password: 'not-the-password', code: '000000' });
    assert.deepEqual([r.reason, r.final], ['wrong-password', true]);
  }
  const locked = await refusal(viewer(t).open({ route: 'backup', macName }));
  assert.equal(locked.reason, 'locked-out');
  const owner = await passkey(t, ctx);
  assert.equal(owner.end.t, 'ready', 'passkeys are counted separately');
  owner.v.send({ t: 'bye' });

  // Turning backup sign-in off stops listening on the name topic; a new Mac name removes the password.
  await app.call('updateSettings', { backupOn: false });
  assert.equal((await app.call('debug')).signaling.listening.name, null);
  await app.call('updateSettings', { backupOn: true });
  assert.ok((await app.call('debug')).signaling.listening.name);
  const newName = await app.call('newMacName');
  assert.notEqual(newName, macName);
  st = await app.call('state');
  assert.deepEqual([st.macName, st.backup.set, st.backup.on], [newName, false, false]);
  assert.equal((await app.call('debug')).signaling.listening.name, null);
});

test('a name the owner chose: checked, normalized, and backup sign-in works with it', async (t) => {
  const ctx = await pairedHost(t);
  const { app, macName } = ctx;
  for (const bad of ['abc', 'a'.repeat(41), 'my--mac', '-mymac', 'mymac-', 'my.mac', 'mäc-book', '']) {
    await assert.rejects(app.call('customMacName', bad), /4 to 40 letters or numbers/, JSON.stringify(bad));
  }
  await assert.rejects(app.call('customMacName', macName), /already this Mac/);
  assert.equal(await app.call('customMacName', '  Jordan MacBook  '), 'jordan-macbook');
  const st = await app.call('state');
  assert.equal(st.macName, 'jordan-macbook');
  assert.equal(st.devices.length, 1, 'devices keep working');
  assert.ok(st.activity.some(a => /renamed to jordan-macbook/.test(a.text)));
  // The chosen name is the backup sign-in's username, as a made-up one is.
  await setBackupPassword(app, 'correct-horse-battery-staple');
  const v = viewer(t);
  await v.open({ route: 'backup', macName: 'Jordan-MacBook' });
  const end = await v.signInBackup({ password: 'correct-horse-battery-staple', code: () => app.freshCode() });
  assert.equal(end.t, 'ready', 'signed in with the backup password under the chosen name');
});

test('backup sign-in: a right password followed by a wrong code is one failure, not two', async (t) => {
  const ctx = await pairedHost(t);
  const { app, macName } = ctx;
  await setBackupPassword(app, 'correct-horse-battery-staple');
  const v = viewer(t);
  await v.open({ route: 'backup', macName });
  const end = await v.signInBackup({ password: 'correct-horse-battery-staple', code: [wrongCode(app)] });
  assert.deepEqual([end.t, end.reason, end.final], ['denied', 'wrong-code', false]);
  await sleep(100);
  assert.equal((await app.call('debug')).limits.backup.fails, 1);
});

// --- someone in the middle ---

test('a changed SDP on the way makes every proof fail, and nothing is sent', async (t) => {
  const ctx = await pairedHost(t, { streamAlways: true });
  const { app } = ctx;
  await setBackupPassword(app, 'correct-horse-battery-staple');
  const devicesBefore = (await app.call('state')).devices.length;

  const cases = [
    ['passkey', 'offer', 'bad-proof'], ['passkey', 'answer', 'bad-proof'],
    ['pair', 'offer', 'bad-link'], ['pair', 'answer', 'bad-link'],
    ['backup', 'offer', 'bad-proof'], ['backup', 'answer', 'bad-proof'],
  ];
  for (const [route, which, reason] of cases) {
    const v = viewer(t, { authenticator: ctx.authn });
    const tamper = { [which]: bumpOrigin };
    let end;
    if (route === 'pair') {
      const { link } = await app.call('pairStart');
      const p = parsePairLink(link);
      await v.open({ route, hostId: p.hostId, sigKey: p.sigKey, pairId: p.pairId, tamper });
      v.sendInput({ t: 'k', c: 'KeyA', k: 'a', d: true, m: 0 });
      end = await v.signInPair({ pairId: p.pairId, pairSecret: p.pairSecret, code: () => app.freshCode() });
    } else if (route === 'backup') {
      await v.open({ route, macName: ctx.macName, tamper });
      v.sendInput({ t: 'k', c: 'KeyA', k: 'a', d: true, m: 0 });
      end = await v.signInBackup({ password: 'correct-horse-battery-staple', code: () => app.freshCode() });
    } else {
      await v.open({ route, hostId: ctx.hostId, sigKey: ctx.sigKey, tamper });
      v.sendInput({ t: 'k', c: 'KeyA', k: 'a', d: true, m: 0 });
      end = await v.signInPasskey({ credentialId: ctx.credentialId, code: () => app.freshCode() });
    }
    assert.deepEqual([end.t, end.reason, end.final], ['denied', reason, true], `${route}, ${which} changed`);
    assert.ok(!v.all.some(m => m.t === 'totp' || m.t === 'ready'), `${route}: never got as far as the code`);
    await sleep(300);
    assert.equal(v.media.video + v.media.audio, 0, `${route}: no media`);
  }
  assert.equal(app.inputs.length, 0, 'no input reached the app');
  const dbg = await app.call('debug');
  assert.equal(dbg.captureOn, false, 'capture never started');
  assert.equal(app.commands.filter(c => c.c === 'capture').length, 2, 'only the pairing in pairedHost() captured');
  assert.equal((await app.call('state')).devices.length, devicesBefore, 'no device was added');
});

// --- during a session ---

test('microphone: packets reach the app only from the signed-in owner while it is switched on', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  const { v, end } = await passkey(t, ctx);
  assert.equal(end.t, 'ready');
  assert.ok(v.firstReply.caps.includes('mic'));

  // Off: whatever arrives on the sound line is dropped.
  await v.sendMicPackets(5);
  await sleep(200);
  assert.equal(app.mic.length, 0, 'nothing is passed on while the microphone is off');

  let since = app.commands.length;
  v.send({ t: 'mic', on: true });
  const on = await app.waitForCommand(c => c.c === 'mic', { since });
  assert.deepEqual([on.on, 'device' in on], [true, false], 'the Mac\'s own output unless Setup chose another');
  await v.sendMicPackets(20, { startSeq: 65530 });
  for (let i = 0; i < 40 && app.mic.length < 20; i++) await sleep(50);
  assert.deepEqual(app.mic.map(p => p.seq), Array.from({ length: 20 }, (_, i) => (65530 + i) & 0xffff), 'in order, sequence numbers kept');
  assert.ok(app.mic.every(p => p.bytes === 60));
  assert.match((await app.call('state')).activity[0].text, /Microphone on/);

  since = app.commands.length;
  v.send({ t: 'mic', on: false });
  assert.equal((await app.waitForCommand(c => c.c === 'mic', { since })).on, false);
  const before = app.mic.length;
  await v.sendMicPackets(5);
  await sleep(200);
  assert.equal(app.mic.length, before);

  // An output chosen in Setup is passed along; one that has gone switches the viewer's microphone off again.
  app.event({ e: 'audio-outputs', list: [{ uid: 'BuiltIn', name: 'MacBook Speakers', main: true }, { uid: 'gone', name: 'Old Headphones' }] });
  await sleep(100);
  assert.deepEqual((await app.call('state')).audioOutputs.map(d => d.uid), ['BuiltIn', 'gone']);
  await assert.rejects(app.call('updateSettings', { micOutput: 'nope' }), /sound outputs/);
  await app.call('updateSettings', { micOutput: 'gone' });
  since = app.commands.length;
  v.send({ t: 'mic', on: true });
  assert.equal((await app.waitForCommand(c => c.c === 'mic', { since })).device, 'gone');
  const off = await v.next(['mic']);
  assert.deepEqual([off.on, typeof off.error], [false, 'string']);

  // Ending the session stops playback on the Mac.
  await app.call('updateSettings', { micOutput: '' });
  v.send({ t: 'mic', on: true });
  await sleep(150);
  since = app.commands.length;
  v.close();
  assert.equal((await app.waitForCommand(c => c.c === 'mic', { since })).on, false);
});

test('one window: the list, choosing it, reshaping it, and going back to the whole screen', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  const { v, end } = await passkey(t, ctx);
  assert.equal(end.t, 'ready');
  assert.ok(v.firstReply.caps.includes('window'));

  v.send({ t: 'windows' });
  const list = await v.next(['windows']);
  assert.deepEqual(list.list, [{ id: 7, app: 'Test App', title: 'Test Window', width: 800, height: 600 }]);

  // Nothing is reshaped while no window is chosen, and junk ids are ignored.
  let since = app.commands.length;
  v.send({ t: 'fit', w: 390, h: 844 });
  v.send({ t: 'window', id: 'seven' });
  v.send({ t: 'window', id: -1 });
  v.send({ t: 'window', id: 7 });
  const one = await app.waitForCommand(c => c.c === 'capture' && c.on, { since });
  assert.equal(one.window, 7);
  assert.equal(app.commands.slice(since).some(c => c.c === 'window-fit'), false);
  const statusWindow = async (want) => {
    for (let i = 0; i < 100; i++) {
      if (v.all.findLast(m => m.t === 'status')?.window === want) return;
      await sleep(50);
    }
    assert.fail(`no status with window ${want}`);
  };
  await statusWindow(7);

  since = app.commands.length;
  v.send({ t: 'fit', w: 390, h: 844 });
  const fit = await app.waitForCommand(c => c.c === 'window-fit', { since });
  assert.deepEqual([fit.window, fit.w, fit.h], [7, 390, 844]);
  assert.equal((await v.next(['fit'])).ok, true);

  // Back to the whole display.
  since = app.commands.length;
  v.send({ t: 'window', id: null });
  const whole = await app.waitForCommand(c => c.c === 'capture' && c.on, { since });
  assert.equal('window' in whole, false);
  await statusWindow(null);

  // A window that has gone: the app shows the whole display, and the host stops asking for that window.
  since = app.commands.length;
  v.send({ t: 'window', id: 99 });
  await app.waitForCommand(c => c.c === 'capture' && c.window === 99, { since });
  await sleep(150);
  since = app.commands.length;
  v.send({ t: 'quality', preset: 'sharp' });
  const after = await app.waitForCommand(c => c.c === 'capture' && c.on, { since });
  assert.equal('window' in after, false, 'the gone window is forgotten');

  // Switching display drops the chosen window.
  v.send({ t: 'window', id: 7 });
  await app.waitForCommand(c => c.c === 'capture' && c.window === 7, { since });
  since = app.commands.length;
  v.send({ t: 'display', id: 2 });
  const other = await app.waitForCommand(c => c.c === 'capture' && c.on, { since });
  assert.deepEqual([other.display, 'window' in other], [2, false]);
});

test('clipboard text both ways, for the signed-in owner only', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  const { v, end } = await passkey(t, ctx);
  assert.equal(end.t, 'ready');
  assert.ok(v.firstReply.caps.includes('clipboard'));
  v.send({ t: 'clip-set', text: 'from the phone \u{1F426}', paste: true });
  assert.deepEqual(await v.next(['clip-set']), { t: 'clip-set', ok: true });
  assert.deepEqual([app.clipboard, app.pasted], ['from the phone \u{1F426}', 1]);
  v.send({ t: 'clip-get' });
  assert.deepEqual(await v.next(['clip']), { t: 'clip', ok: true, text: 'from the phone \u{1F426}' });
  v.send({ t: 'clip-set', text: 'x'.repeat(30001) });
  assert.equal((await v.next(['clip-set'])).ok, false);
  assert.equal(app.clipboard, 'from the phone \u{1F426}', 'too long: nothing changed');
});

test('after a click, the viewer hears whether the Mac now waits for typing', async (t) => {
  const ctx = await pairedHost(t);
  const { v, end } = await passkey(t, ctx);
  assert.equal(end.t, 'ready');
  assert.ok(v.firstReply.caps.includes('textfocus'));
  v.sendInput({ t: 'b', b: 0, d: true, x: 0.3, y: 0.2, n: 1 });
  v.sendInput({ t: 'b', b: 0, d: false, x: 0.3, y: 0.2, n: 1 });
  assert.deepEqual(await v.next(['textfocus']), { t: 'textfocus', editable: true, secure: false });
  v.sendInput({ t: 'b', b: 0, d: true, x: 0.3, y: 0.8, n: 1 });
  v.sendInput({ t: 'b', b: 0, d: false, x: 0.3, y: 0.8, n: 1 });
  assert.equal((await v.next(['textfocus'])).editable, false);
});

test('quality, display and keyframe requests reach the app; junk during sign-in ends it', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  const { v, end } = await passkey(t, ctx);
  assert.equal(end.t, 'ready');

  let since = app.commands.length;
  v.send({ t: 'quality', preset: 'sharp' });
  const sharp = await app.waitForCommand(c => c.c === 'capture' && c.on, { since });
  assert.deepEqual([sharp.maxEdge, sharp.kbps, sharp.display], [2880, 10000, 1]);

  since = app.commands.length;
  v.send({ t: 'display', id: 99 });          // no such display: ignored
  v.send({ t: 'quality', preset: 'ultra' }); // no such preset: ignored
  v.send({ t: 'display', id: 2 });
  const second = await app.waitForCommand(c => c.c === 'capture' && c.on, { since });
  assert.equal(second.display, 2);
  await sleep(200);
  assert.equal(app.commands.slice(since).filter(c => c.c === 'capture').length, 1);

  await sleep(600); // past the keyframe throttle
  since = app.commands.length;
  v.send({ t: 'keyframe' });
  await app.waitForCommand(c => c.c === 'keyframe', { since });

  // A viewer that isn't signed in yet and sends session messages is cut off.
  const w = viewer(t, { authenticator: ctx.authn });
  await w.open({ route: 'passkey', hostId: ctx.hostId, sigKey: ctx.sigKey });
  w.send({ t: 'quality', preset: 'smooth' });
  const denied = await w.next(['denied']);
  assert.deepEqual([denied.reason, denied.final], ['protocol', true]);
  assert.equal((await app.call('state')).session.viewer, 'Passkey viewer', 'the signed-in viewer is untouched');
});

test('no input for the idle time ends the session', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  await app.call('updateSettings', { idleMinutes: 0.03 }); // test mode allows ~2 seconds
  const { v, end } = await passkey(t, ctx);
  assert.equal(end.t, 'ready');
  const t0 = Date.now();
  // Input keeps it alive...
  for (let i = 0; i < 6; i++) { v.sendInput({ t: 'k', c: 'ShiftLeft', k: 'Shift', d: i % 2 === 0, m: 0 }); await sleep(500); }
  assert.ok(!v.all.some(m => m.t === 'bye'), 'still connected while there is input');
  // ...and silence ends it.
  const bye = await v.next(['bye'], 6000);
  assert.equal(bye.reason, 'idle');
  assert.ok(Date.now() - t0 >= 3000);
  await app.waitFor(async () => (await app.call('state')).session === null, { what: 'the session to end' });
  assert.ok((await app.call('state')).activity.some(a => /no input for a while/.test(a.text)));
});

test('"Never" keeps a session however long there is no input', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  await assert.rejects(app.call('updateSettings', { idleMinutes: -1 }), /from 1 to 1440, or never/);
  await app.call('updateSettings', { idleMinutes: 0 });
  assert.equal((await app.call('state')).settings.idleMinutes, 0);
  const { v, end } = await passkey(t, ctx);
  assert.equal(end.t, 'ready');
  await sleep(3000); // longer than the ~2 s test idle time below, with no input at all
  assert.ok(!v.all.some(m => m.t === 'bye'), 'still connected with "Never"');
  assert.ok((await app.call('state')).session, 'the session is still there');
  v.send({ t: 'bye' });
});

test('pausing ends the session and refuses viewers until resumed; the menu works the same', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  const { v } = await passkey(t, ctx);
  await app.call('updateSettings', { paused: true });
  assert.equal((await v.next(['bye'])).reason, 'paused');
  const st = await app.call('state');
  assert.deepEqual([st.state, st.session], ['paused', null]);
  assert.equal((await refusal(viewer(t).open({ route: 'passkey', hostId: ctx.hostId, sigKey: ctx.sigKey }))).reason, 'paused');
  await app.waitForCommand(c => c.c === 'status' && c.state === 'paused' && c.settings.paused === true);

  // The menu bar's Resume and Disconnect.
  app.event({ e: 'menu', action: 'resume' });
  await app.waitFor(async () => (await app.call('state')).state === 'ready', { what: 'resume' });
  const second = await passkey(t, ctx);
  assert.equal(second.end.t, 'ready');
  app.event({ e: 'menu', action: 'disconnect' });
  assert.equal((await second.v.next(['bye'])).reason, 'disconnected');
  app.event({ e: 'menu', action: 'pause' });
  await app.waitFor(async () => (await app.call('state')).settings.paused === true, { what: 'pause from the menu' });
  app.event({ e: 'menu', action: 'keep-awake-off' });
  await app.waitForCommand(c => c.c === 'keep-awake' && c.on === false);
});

test('removing the device ends its session, and that passkey no longer gets in', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  const { v } = await passkey(t, ctx);
  const renamed = await app.call('deviceRename', ctx.credentialId, '  Work laptop\u0007 ');
  assert.equal(renamed.label, 'Work laptop');
  assert.equal(await app.call('deviceRemove', ctx.credentialId), true);
  assert.equal((await v.next(['bye'])).reason, 'removed');
  const st = await app.call('state');
  assert.deepEqual([st.devices.length, st.state], [0, 'needs-setup']);
  assert.equal((await refusal(viewer(t).open({ route: 'passkey', hostId: ctx.hostId, sigKey: ctx.sigKey }))).reason, 'not-set-up');
});

test('without Accessibility the viewer can watch but not control, until it is allowed', async (t) => {
  const ctx = await pairedHost(t, { permissions: { screen: true, accessibility: false } });
  const { app } = ctx;
  const { v, end } = await passkey(t, ctx);
  assert.equal(end.input, false);
  await v.waitForMedia(m => m.keyframes >= 1);
  v.sendInput({ t: 'k', c: 'KeyQ', k: 'q', d: true, m: 8 });
  await sleep(300);
  assert.equal(app.inputs.length, 0, 'view only');

  app.setPermissions({ accessibility: true });
  const status = await nextWhere(v, 'status', m => m.input === true);
  assert.equal(status.input, true);
  v.sendInput({ t: 'k', c: 'KeyQ', k: 'q', d: true, m: 8 });
  await app.waitFor(() => app.inputs.length === 1, { what: 'input once allowed' });
});

test('without Screen Recording the viewer is told so', async (t) => {
  const ctx = await pairedHost(t, { permissions: { screen: false, accessibility: true } });
  const { v, end } = await passkey(t, ctx);
  assert.equal(end.t, 'ready');
  const err = await v.next(['error']);
  assert.equal(err.code, 'no-screen-permission');
  ctx.app.event({ e: 'capture-error', code: 'capture-failed', message: 'The display went away.' });
  assert.deepEqual(await v.next(['error']), { t: 'error', code: 'capture-failed', message: 'The display went away.' });
});

// --- limits on sessions that haven't signed in ---

test('at most three sign-ins at once, and each must finish in time', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  await app.call('setAuthTimeout', 2500);
  const waiting = [];
  for (let i = 0; i < 3; i++) {
    const v = viewer(t, { authenticator: ctx.authn });
    await v.open({ route: 'passkey', hostId: ctx.hostId, sigKey: ctx.sigKey });
    waiting.push(v);
  }
  const busy = await refusal(viewer(t).open({ route: 'passkey', hostId: ctx.hostId, sigKey: ctx.sigKey }));
  assert.equal(busy.reason, 'busy');
  for (const v of waiting) {
    const d = await v.next(['denied'], 6000);
    assert.deepEqual([d.reason, d.final], ['timeout', true]);
  }
  await app.waitFor(async () => (await app.call('debug')).sessions.length === 0, { what: 'timed-out sessions to go' });
  const ok = await passkey(t, ctx);
  assert.equal(ok.end.t, 'ready', 'room again once they timed out');
});

// --- the app and the menu bar ---

test('the menu bar status follows the state; quitting says goodbye to the viewer; a second run does not open Setup', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'perch-host-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const app = await host(t, { home });
  await app.waitForCommand(c => c.c === 'status' && c.state === 'needs-setup');
  const status = app.commands.findLast(c => c.c === 'status');
  assert.equal(status.macName, identity(app).macName);
  assert.match(status.setupUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?k=/);
  assert.equal(status.text, 'Finish setting up: add Perch to your authenticator app');

  await app.setupTotp();
  const { v } = await pair(t, app);
  await app.waitForCommand(c => c.c === 'status' && c.state === 'connected' && /is connected$/.test(c.text));

  // The app closing our stdin is how it quits us: the viewer hears why, and the host exits cleanly.
  const exit = await app.stop();
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal((await v.next(['bye'], 3000)).reason, 'quit');

  const again = await host(t, { home });
  await again.waitForCommand(c => c.c === 'status' && c.state === 'ready');
  assert.ok(!again.commands.some(c => c.c === 'open-url'), 'Setup opens by itself only on the first run');
  assert.equal((await again.call('state')).devices.length, 1, 'remembered across restarts');
});

test('reset forgets everything: old passkeys and addresses stop working', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  const { v } = await passkey(t, ctx);
  await app.call('reset');
  assert.equal((await v.next(['bye'])).reason, 'removed');
  const after = identity(app);
  assert.notDeepEqual(after.hostId, ctx.hostId);
  assert.notEqual(after.macName, ctx.macName);
  const st = await app.call('state');
  assert.deepEqual([st.devices.length, st.totp.set, st.backup.set], [0, false, false]);
  // Nobody listens at the old address any more.
  await assert.rejects(viewer(t).open({ route: 'passkey', hostId: ctx.hostId, sigKey: ctx.sigKey, timeoutMs: 1500 }), /no offer/);
  const r = await refusal(viewer(t).open({ route: 'passkey', hostId: after.hostId, sigKey: after.sigKey }));
  assert.equal(r.reason, 'not-set-up');
  // The new identity has its own connection certificate at once: pairing links carry its pin and one-tap sign-in
  // is offered, without waiting for a restart.
  await app.setupTotp();
  const { link } = await app.call('pairStart');
  assert.equal(Buffer.from(new URL(link).hash.replace('#pair=', ''), 'base64url').length, 16 + 32 + 16 + 32 + 16, 'link with a pin');
  const again = await pair(t, app);
  assert.equal(again.end.t, 'ready');
  assert.ok(again.v.firstReply.caps.includes('quick'));
});

test('one-tap sign-in: the passkey signs the viewer\'s own certificate up front; replays, old times and other certificates are refused', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  // A good one: the Mac offers "quick", and a passkey over (r, ts, this viewer's fingerprint) is accepted.
  const v = viewer(t, { authenticator: ctx.authn, label: 'One-tap viewer' });
  await v.open({ route: 'passkey', hostId: ctx.hostId, sigKey: ctx.sigKey });
  assert.ok(v.firstReply.caps.includes('quick'));
  const r = randomBytes(16);
  const end = await v.signInQuick({ credentialId: ctx.credentialId, code: () => app.freshCode(), r });
  assert.equal(end.t, 'ready', JSON.stringify(end));
  v.send({ t: 'bye' });
  await app.waitFor(async () => (await app.call('state')).session === null, { what: 'the session to end' });
  await v.close();

  const refusedWith = async (opts, what) => {
    const w = viewer(t, { authenticator: ctx.authn, label: what });
    await w.open({ route: 'passkey', hostId: ctx.hostId, sigKey: ctx.sigKey });
    const res = await w.signInQuick({ credentialId: ctx.credentialId, code: () => app.freshCode(), ...opts });
    await w.close();
    return res;
  };
  // The same r again (a replayed assertion), a time from 10 minutes ago, and a passkey that signed some other
  // certificate (made for a different connection) all fail at factor one.
  for (const [opts, what] of [
    [{ r }, 'replayed r'],
    [{ ts: Date.now() - 10 * 60_000 }, 'stale time'],
    [{ fingerprint: `sha-256 ${Array(32).fill('AB').join(':')}` }, 'another certificate'],
  ]) {
    const res = await refusedWith(opts, what);
    assert.equal(res.t, 'denied', `${what}: ${JSON.stringify(res)}`);
    assert.equal(res.reason, 'bad-proof', what);
  }
});

test('passkeys made before one-tap sign-in (48-byte user handle) still sign in', async (t) => {
  const ctx = await pairedHost(t);
  const legacy = Buffer.from([...ctx.hostId, ...ctx.sigKey]).toString('base64url');
  const { end } = await passkey(t, ctx, { overrides: { userHandle: legacy } });
  assert.equal(end.t, 'ready', JSON.stringify(end));
});

test('the picture is no bigger than the viewer\'s screen, and capture keeps the bitrate the link is carrying', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  const { v, end } = await passkey(t, ctx);
  assert.equal(end.t, 'ready');
  const first = app.commands.filter(c => c.c === 'capture' && c.on).at(-1);
  assert.deepEqual([first.maxEdge, first.fps, first.kbps], [1920, 30, 5000]);
  // A phone held upright shows the Mac's picture about 1170 pixels wide.
  let since = app.commands.length;
  v.send({ t: 'view', edge: 1170 });
  const phone = await app.waitForCommand(c => c.c === 'capture' && c.on, { since });
  assert.equal(phone.maxEdge, 1280);
  // Junk and repeats change nothing.
  since = app.commands.length;
  v.send({ t: 'view', edge: 'big' });
  v.send({ t: 'view', edge: 1200 });
  v.send({ t: 'quality', preset: 'fast' });
  const fast = await app.waitForCommand(c => c.c === 'capture' && c.on, { since });
  assert.deepEqual([fast.maxEdge, fast.fps, fast.kbps], [1280, 60, 8000], '60 frames a second, still phone-sized');
  assert.equal(app.commands.slice(since).filter(c => c.c === 'capture').length, 1);
  assert.ok(v.firstReply.caps.includes('fps60') && v.firstReply.caps.includes('view'));
});

test('an added site: pairing and signing in there work; removing the site removes its devices', async (t) => {
  const app = await host(t);
  await app.setupTotp();
  const MINE = 'https://perch.example.org';
  // Not accepted yet: pairing from that site is refused.
  const { link } = await app.call('pairStart');
  const p0 = parsePairLink(link);
  const mine = new SoftAuthenticator({ rpId: 'perch.example.org', origin: MINE });
  const v0 = viewer(t, { authenticator: mine });
  await v0.open({ route: 'pair', hostId: p0.hostId, sigKey: p0.sigKey, pairId: p0.pairId });
  const refused = await v0.signInPair({ pairId: p0.pairId, pairSecret: p0.pairSecret, code: () => app.freshCode(), origin: MINE });
  assert.deepEqual([refused.t, refused.reason], ['denied', 'origin']);
  await v0.close();

  await assert.rejects(app.call('siteAdd', 'https://10.0.0.1/x'), /domain name/);
  assert.deepEqual(await app.call('siteAdd', `${MINE}/perch/`), { origin: MINE, url: `${MINE}/perch/connect.html` });
  const made = await app.call('pairStart', MINE);
  assert.ok(made.link.startsWith(`${MINE}/perch/connect.html#pair=`));
  const p = parsePairLink(made.link);
  const v = viewer(t, { authenticator: mine, label: 'My own site' });
  await v.open({ route: 'pair', hostId: p.hostId, sigKey: p.sigKey, pairId: p.pairId });
  const end = await v.signInPair({ pairId: p.pairId, pairSecret: p.pairSecret, code: () => app.freshCode(), origin: MINE });
  assert.equal(end.t, 'ready', JSON.stringify(end));
  const st = await app.call('state');
  assert.deepEqual(st.devices.map(d => [d.label, d.site]), [['My own site', 'perch.example.org']]);
  // Removing the site ends the session and removes the device paired there.
  assert.deepEqual(await app.call('siteRemove', MINE), { removedDevices: 1 });
  assert.equal((await v.next(['bye'])).reason, 'removed');
  assert.equal((await app.call('state')).devices.length, 0);
  await assert.rejects(app.call('siteRemove', TEST_ORIGIN), /can’t be removed/);
});

test('lock on disconnect and the privacy curtain: the app is told when the owner switched them on', async (t) => {
  const ctx = await pairedHost(t);
  const { app } = ctx;
  // Off by default: a session starts without the curtain, and ending it locks nothing.
  let first = await passkey(t, ctx);
  assert.equal(app.commands.filter(c => c.c === 'session' && c.active).at(-1).curtain, false);
  first.v.send({ t: 'bye' });
  await app.waitFor(async () => (await app.call('state')).session === null, { what: 'session over' });
  assert.equal(app.commands.some(c => c.c === 'lock'), false);

  await app.call('updateSettings', { lockOnDisconnect: true, curtain: true });
  const { v } = await passkey(t, ctx);
  assert.equal(app.commands.filter(c => c.c === 'session' && c.active).at(-1).curtain, true);
  // Switching the curtain off mid-session lowers it at once.
  let since = app.commands.length;
  await app.call('updateSettings', { curtain: false });
  assert.equal((await app.waitForCommand(c => c.c === 'session' && c.active, { since })).curtain, false);
  // Another of the owner's devices taking over doesn't lock the Mac; the last one leaving does.
  since = app.commands.length;
  const second = await passkey(t, ctx, { label: 'Second device' });
  assert.equal((await v.next(['bye'])).reason, 'signed-in-elsewhere');
  assert.equal(app.commands.slice(since).some(c => c.c === 'lock'), false);
  second.v.send({ t: 'bye' });
  await app.waitForCommand(c => c.c === 'lock', { since });
  const tail = app.commands.slice(since).map(c => c.c);
  assert.ok(tail.lastIndexOf('lock') > tail.lastIndexOf('session'), 'locked after the session ended');
});

test('guest link: watch only, alongside the owner or alone; ends when stopped or when it runs out', async (t) => {
  const ctx = await pairedHost(t, { streamAlways: true });
  const { app } = ctx;
  const parse = link => {
    const b = Buffer.from(new URL(link).hash.replace('#guest=', ''), 'base64url');
    return { guestId: new Uint8Array(b.subarray(0, 16)), guestSecret: new Uint8Array(b.subarray(16, 48)), pin: b.subarray(48) };
  };
  // No link yet: nobody is listening for guests.
  const made = await app.call('guestStart', 30);
  const g = parse(made.link);
  assert.equal(g.pin.length, 16, 'the link carries the Mac\'s certificate pin, and nothing else about the Mac');
  assert.equal((await app.call('state')).guest.watching, 0);

  // A wrong secret is refused; the right one gets a view-only session with picture and sound.
  const bad = viewer(t, { label: 'Wrong link' });
  await bad.open({ route: 'guest', guestId: g.guestId, guestSecret: g.guestSecret });
  const refused = await bad.signInGuest({ guestSecret: new Uint8Array(32) });
  assert.deepEqual([refused.t, refused.reason], ['denied', 'bad-link']);
  await bad.close();

  const guest = viewer(t, { label: 'Guest' });
  await guest.open({ route: 'guest', guestId: g.guestId, guestSecret: g.guestSecret });
  const ready = await guest.signInGuest({ guestSecret: g.guestSecret });
  assert.deepEqual([ready.t, ready.guest, ready.input], ['ready', true, false]);
  await app.waitFor(() => guest.media.video > 20 && guest.media.audio > 5, { what: 'picture and sound for the guest' });
  assert.equal((await app.call('state')).guest.watching, 1);
  assert.equal((await app.call('state')).session, null, 'a guest is not the owner\'s session');

  // Nothing a guest sends can touch the Mac.
  const before = app.inputs.length, cmds = app.commands.length;
  guest.sendInput({ t: 'k', c: 'KeyA', k: 'a', d: true, m: 0 });
  guest.sendInput({ t: 'b', b: 0, d: true, x: 0.5, y: 0.5, n: 1 });
  guest.send({ t: 'quality', preset: 'sharp' });
  guest.send({ t: 'display', id: 2 });
  await new Promise(r => setTimeout(r, 400));
  assert.equal(app.inputs.length, before, 'no input from a guest');
  assert.equal(app.commands.slice(cmds).some(c => c.c === 'capture'), false, 'a guest can\'t change what is shown');

  // The owner signs in too: both get the picture, only the owner controls, and the guest stays when the owner leaves.
  const owner = await passkey(t, ctx);
  assert.equal(owner.end.t, 'ready');
  const v0 = guest.media.video;
  await app.waitFor(() => owner.v.media.video > 20 && guest.media.video > v0 + 20, { what: 'picture for both' });
  owner.v.sendInput({ t: 'k', c: 'KeyB', k: 'b', d: true, m: 0 });
  await app.waitFor(() => app.inputs.some(i => i.ev.c === 'KeyB'), { what: 'the owner\'s key' });
  // The owner shows one window on the second display, then leaves: the guest keeps seeing just that window.
  owner.v.send({ t: 'display', id: 2 });
  await app.waitForCommand(c => c.c === 'capture' && c.display === 2);
  owner.v.send({ t: 'window', id: 7 });
  await app.waitForCommand(c => c.c === 'capture' && c.window === 7);
  const beforeBye = app.commands.length;
  owner.v.send({ t: 'bye' });
  await app.waitFor(async () => (await app.call('state')).session === null, { what: 'the owner to leave' });
  const v1 = guest.media.video;
  await app.waitFor(() => guest.media.video > v1 + 20, { what: 'the guest still watching' });
  const kept = app.commands.slice(beforeBye).filter(c => c.c === 'capture').at(-1);
  assert.deepEqual([kept?.on, kept?.display, kept?.window], [true, 2, 7], 'the guest sees no more than the owner was showing');

  // Stopping the link disconnects the guest and stops the picture; the link no longer works.
  await app.call('guestStop');
  assert.equal((await guest.next(['bye'])).reason, 'removed');
  await app.waitForCommand(c => c.c === 'capture' && c.on === false);
  await assert.rejects(viewer(t).open({ route: 'guest', guestId: g.guestId, guestSecret: g.guestSecret, timeoutMs: 1500 }), /no offer/);

  // A link that runs out does the same by itself.
  const short = parse((await app.call('guestStart', 1)).link);
  const late = viewer(t, { label: 'Late guest' });
  await late.open({ route: 'guest', guestId: short.guestId, guestSecret: short.guestSecret });
  assert.equal((await late.signInGuest({ guestSecret: short.guestSecret })).t, 'ready');
  await app.advance(61_000);
  assert.equal((await app.call('state')).guest, null);
});

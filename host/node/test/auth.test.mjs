// Sign-in checks with real WebAuthn responses (software ES256 authenticator), pairing links, TOTP and OPAQUE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import * as opaque from '@serenity-kit/opaque';
import { Store } from '../src/store.mjs';
import { Auth, AuthError, checkClientData } from '../src/auth.mjs';
import { totp } from '../src/totp.mjs';
import { MAX_FAILS } from '../src/limits.mjs';
import { SoftAuthenticator, FLAG } from './soft-authenticator.mjs';
import { toB64url, fromB64url, equalBytes } from '../../../site/js/shared/bytes.js';
import { bindProof } from '../../../site/js/shared/bind.js';
import { APP_ORIGIN, RP_ID, CONNECT_URL, PAIR_TTL_MS } from '../../../site/js/shared/proto.js';

const config = { origins: [APP_ORIGIN], rpId: RP_ID, site: CONNECT_URL };
const homes = [];
test.after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

async function setup({ withTotp = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'perch-auth-'));
  homes.push(home);
  const store = await Store.open({ home, secrets: 'file' });
  let clock = 1_800_000_000_000;
  const auth = new Auth({ store, config, now: () => clock });
  await auth.init();
  const ctl = { store, auth, tick: ms => { clock += ms; }, get now() { return clock; } };
  if (withTotp) {
    const { secret } = auth.totpStart();
    ctl.secret = auth.pendingTotp.secret;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    await auth.totpConfirm(totp(ctl.secret, clock));
  }
  ctl.code = (offset = 0) => totp(ctl.secret, clock + offset);
  return ctl;
}

const bindOf = () => new Uint8Array(randomBytes(32));

async function rejects(p, reason, why = /./) {
  await assert.rejects(p, e => e instanceof AuthError && e.reason === reason && why.test(e.message), `expected ${reason} (${why})`);
}

async function paired() {
  const ctl = await setup();
  const soft = new SoftAuthenticator({ rpId: RP_ID, origin: APP_ORIGIN });
  const bind = bindOf();
  const options = ctl.auth.creationOptions(bind);
  const cred = await ctl.auth.verifyRegistration(soft.create(options), bind);
  ctl.store.addDevice({ ...cred, label: 'Test phone' });
  return { ...ctl, soft, cred };
}

test('creation options follow the protocol', async () => {
  const { auth, store } = await setup();
  const bind = bindOf();
  const o = auth.creationOptions(bind);
  assert.equal(o.challenge, toB64url(bind));
  assert.deepEqual(o.rp, { id: RP_ID, name: 'Perch' });
  assert.ok(equalBytes(fromB64url(o.user.id), store.userHandle));
  assert.equal(fromB64url(o.user.id).length, 48);
  assert.equal(o.user.name, `Perch · ${store.macName}`);
  assert.equal(o.user.displayName, `Perch on ${store.macName}`);
  assert.deepEqual(o.pubKeyCredParams.map(p => p.alg), [-7, -8, -257]);
  assert.equal(o.authenticatorSelection.residentKey, 'required');
  assert.equal(o.authenticatorSelection.userVerification, 'required');
  assert.equal(o.attestation, 'none');
  assert.deepEqual(o.excludeCredentials, []);
});

test('a real registration and sign-in verify, and the counter is saved', async () => {
  const { auth, store, soft, cred } = await paired();
  assert.equal(typeof cred.publicKey, 'string');
  assert.equal(auth.creationOptions(bindOf()).excludeCredentials[0].id, cred.id);
  for (let i = 1; i <= 3; i++) {
    const bind = bindOf();
    const dev = await auth.verifyAssertion(soft.get({ challenge: toB64url(bind) }), bind);
    assert.equal(dev.id, cred.id);
    assert.equal(store.findDevice(cred.id).counter, i);
  }
});

test('registration is refused for every bad field', async () => {
  const { auth } = await setup();
  const soft = new SoftAuthenticator({ rpId: RP_ID, origin: APP_ORIGIN });
  const bind = bindOf();
  const opts = auth.creationOptions(bind);
  const cases = [
    ['wrong challenge', { challenge: toB64url(bindOf()) }, 'bad-proof', /binding/],
    ['crossOrigin true', { crossOrigin: true }, 'bad-passkey', /cross-origin/],
    ['topOrigin present', { topOrigin: 'https://evil.example' }, 'bad-passkey', /topOrigin/],
    ['crossOrigin true with topOrigin', { crossOrigin: true, topOrigin: 'https://evil.example' }, 'bad-passkey', /cross-origin/],
    ['wrong origin', { origin: 'https://evil.example' }, 'bad-passkey', /not allowed/],
    ['wrong type', { type: 'webauthn.get' }, 'bad-passkey', /expected webauthn.create/],
    ['user not verified', { flags: FLAG.UP | FLAG.AT }, 'bad-passkey', /verification was required/],
    ['user not present', { flags: FLAG.UV | FLAG.AT }, 'bad-passkey', /presence was required/],
    ['wrong RP ID', { rpId: 'evil.example' }, 'bad-passkey', /RP ID hash/],
    ['id differs from rawId', { id: toB64url(randomBytes(16)) }, 'bad-passkey', /rawId differ/],
  ];
  for (const [name, o, reason, why] of cases) {
    await rejects(auth.verifyRegistration(soft.create(opts, o), bind), reason, why).catch(e => { throw new Error(`${name}: ${e.message}`); });
  }
  // id and rawId agree but are not the credential inside the signed authenticator data.
  const r = soft.create(opts);
  const other = toB64url(randomBytes(16));
  await rejects(auth.verifyRegistration({ ...r, id: other, rawId: other }, bind), 'bad-passkey', /does not match authenticator data/);
  // Junk shapes never reach the library.
  for (const junk of [null, 'x', {}, { id: 'a', rawId: 'a', type: 'public-key' }, { ...r, response: { clientDataJSON: '!!' } }]) {
    await rejects(auth.verifyRegistration(junk, bind), 'bad-passkey');
  }
});

test('a passkey already paired cannot be paired again', async () => {
  const { auth, soft, store } = await paired();
  const bind = bindOf();
  const r = soft.create(auth.creationOptions(bind), { credentialIdBytes: Buffer.from(store.devices[0].id, 'base64url') });
  await rejects(auth.verifyRegistration(r, bind), 'already-paired');
});

test('sign-in is refused for every bad field', async () => {
  const { auth, soft, store, cred } = await paired();
  const bind = bindOf();
  const ch = toB64url(bind);
  const otherKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const cases = [
    ['wrong challenge', { challenge: toB64url(bindOf()) }, 'bad-proof', /binding/],
    ['crossOrigin true', { crossOrigin: true }, 'bad-passkey', /cross-origin/],
    ['topOrigin present', { topOrigin: APP_ORIGIN }, 'bad-passkey', /topOrigin/],
    ['crossOrigin true with topOrigin', { crossOrigin: true, topOrigin: 'https://evil.example' }, 'bad-passkey', /cross-origin/],
    ['wrong origin', { origin: 'https://just-rice.github.io.evil.example' }, 'bad-passkey', /not allowed/],
    ['http origin', { origin: 'http://just-rice.github.io' }, 'bad-passkey', /not allowed/],
    ['wrong type', { type: 'webauthn.create' }, 'bad-passkey', /expected webauthn.get/],
    ['user not verified', { flags: FLAG.UP }, 'bad-passkey', /verification required/],
    ['user not present', { flags: FLAG.UV }, 'bad-passkey', /not present/],
    ['wrong user handle', { userHandle: toB64url(randomBytes(48)) }, 'bad-passkey', /user handle/],
    ['wrong RP ID', { rpId: 'github.io' }, 'bad-passkey', /RP ID hash/],
    ['signed by another key', { signWith: otherKey }, 'bad-passkey', /did not verify/],
    ['unknown credential', { id: toB64url(randomBytes(16)), rawId: undefined }, 'unknown-device', /not one of/],
  ];
  for (const [name, o, reason, why] of cases) {
    const resp = soft.get({ challenge: ch }, o);
    if (name === 'unknown credential') resp.rawId = resp.id;
    await rejects(auth.verifyAssertion(resp, bind), reason, why).catch(e => { throw new Error(`${name}: ${e.message}`); });
  }
  // id ≠ rawId
  const r = soft.get({ challenge: ch });
  await rejects(auth.verifyAssertion({ ...r, rawId: toB64url(randomBytes(16)) }, bind), 'bad-passkey', /rawId differ/);
  // The counter must move forward: a cloned authenticator replaying an older count is refused.
  const ok = soft.get({ challenge: ch }, { counter: 10 });
  await auth.verifyAssertion(ok, bind);
  assert.equal(store.findDevice(cred.id).counter, 10);
  await rejects(auth.verifyAssertion(soft.get({ challenge: ch }, { counter: 9 }), bind), 'bad-passkey', /counter/);
  await rejects(auth.verifyAssertion(soft.get({ challenge: ch }, { counter: 10 }), bind), 'bad-passkey', /counter/);
  // No user handle is fine (the browser had allowCredentials).
  await auth.verifyAssertion(soft.get({ challenge: ch }, { userHandle: null, counter: 11 }), bind);
});

test('synced passkeys that always report counter 0 keep working', async () => {
  const ctl = await setup();
  const soft = new SoftAuthenticator({ rpId: RP_ID, origin: APP_ORIGIN });
  const bind = bindOf();
  const cred = await ctl.auth.verifyRegistration(soft.create(ctl.auth.creationOptions(bind)), bind);
  ctl.store.addDevice({ ...cred, label: 'iCloud' });
  for (let i = 0; i < 3; i++) {
    const b = bindOf();
    await ctl.auth.verifyAssertion(soft.get({ challenge: toB64url(b) }, { counter: 0 }), b);
  }
  assert.equal(ctl.store.findDevice(cred.id).counter, 0);
});

test('clientData policy is applied to both ceremonies', () => {
  const mk = cd => ({ response: { clientDataJSON: Buffer.from(JSON.stringify(cd)).toString('base64url') } });
  assert.doesNotThrow(() => checkClientData(mk({ type: 'webauthn.get', origin: APP_ORIGIN }), 'webauthn.get', [APP_ORIGIN]));
  assert.throws(() => checkClientData(mk({ type: 'webauthn.get', origin: APP_ORIGIN, crossOrigin: 'true' }), 'webauthn.get', [APP_ORIGIN]));
  assert.throws(() => checkClientData(mk({ type: 'webauthn.create', origin: APP_ORIGIN, topOrigin: APP_ORIGIN }), 'webauthn.create', [APP_ORIGIN]));
});

test('pairing links: format, proof, single use, expiry, burn after 3 bad proofs, one at a time', async () => {
  const noTotp = await setup({ withTotp: false });
  assert.throws(() => noTotp.auth.createPairing(), /authenticator app first/);

  const { auth, store, tick } = await setup();
  const { link, expiresAt } = auth.createPairing();
  assert.ok(link.startsWith(`${CONNECT_URL}#pair=`));
  const token = fromB64url(link.split('#pair=')[1]);
  assert.equal(token.length, 96);
  assert.ok(equalBytes(token.subarray(0, 16), store.hostId));
  assert.ok(equalBytes(token.subarray(16, 48), store.sigKey));
  const pairId = toB64url(token.subarray(48, 64));
  const secret = token.subarray(64);
  assert.ok(Number.isFinite(new Date(expiresAt).getTime()));

  const bind = bindOf();
  const good = toB64url(await bindProof(secret, 'pair', bind));
  const holderA = {}, holderB = {};
  await rejects(auth.checkPairProof(toB64url(randomBytes(16)), good, bind, holderA), 'bad-link');
  // A proof over a different connection's binding doesn't count.
  await rejects(auth.checkPairProof(pairId, toB64url(await bindProof(secret, 'pair', bindOf())), bind, holderA), 'bad-link');
  await auth.checkPairProof(pairId, good, bind, holderA);
  await rejects(auth.checkPairProof(pairId, good, bind, holderB), 'link-used');
  auth.releasePairing(holderA);
  await auth.checkPairProof(pairId, good, bind, holderB);
  auth.consumePairing(holderB);
  await rejects(auth.checkPairProof(pairId, good, bind, holderB), 'bad-link');
  assert.equal(auth.pairingInfo(), null);

  // Expiry.
  auth.createPairing();
  const t2 = fromB64url(auth.pairingInfo().link.split('#pair=')[1]);
  tick(PAIR_TTL_MS + 1);
  await rejects(auth.checkPairProof(toB64url(t2.subarray(48, 64)), toB64url(await bindProof(t2.subarray(64), 'pair', bind)), bind, holderA), 'link-expired');
  assert.equal(auth.pairingInfo(), null);

  // Three bad proofs burn it, even if the right one comes next.
  auth.createPairing();
  const t3 = fromB64url(auth.pairingInfo().link.split('#pair=')[1]);
  const id3 = toB64url(t3.subarray(48, 64));
  for (let i = 0; i < 3; i++) await rejects(auth.checkPairProof(id3, toB64url(randomBytes(32)), bind, holderA), 'bad-link');
  await rejects(auth.checkPairProof(id3, toB64url(await bindProof(t3.subarray(64), 'pair', bind)), bind, holderA), 'bad-link');
  assert.equal(auth.pairingInfo(), null);

  // Only one link at a time: a new one replaces the old.
  auth.createPairing();
  const old = fromB64url(auth.pairingInfo().link.split('#pair=')[1]);
  auth.createPairing();
  await rejects(auth.checkPairProof(toB64url(old.subarray(48, 64)), toB64url(await bindProof(old.subarray(64), 'pair', bind)), bind, holderA), 'bad-link');
});

test('authenticator codes: setup, each code once, a window of one step', async () => {
  const ctl = await setup({ withTotp: false });
  await assert.rejects(ctl.auth.totpConfirm('123456'), /Start setting up/);
  ctl.auth.totpStart();
  const secret = ctl.auth.pendingTotp.secret;
  await assert.rejects(ctl.auth.totpConfirm('000000'), /didn't match/);
  await ctl.auth.totpConfirm(totp(secret, ctl.now));
  assert.equal(ctl.store.config.totp.set, true);
  assert.equal(ctl.auth.pendingTotp, null);
  // The setup code itself can't be reused to sign in.
  assert.equal(ctl.auth.checkTotp(totp(secret, ctl.now)), false);
  // Next step: works once, then never again; the previous step is now too old.
  assert.equal(ctl.auth.checkTotp(totp(secret, ctl.now + 30000)), true);
  assert.equal(ctl.auth.checkTotp(totp(secret, ctl.now + 30000)), false);
  ctl.tick(60000);
  assert.equal(ctl.auth.checkTotp(totp(secret, ctl.now - 30000)), false, 'step already passed');
  assert.equal(ctl.auth.checkTotp(totp(secret, ctl.now)), true);
  assert.equal(ctl.auth.checkTotp('12345'), false);
  assert.equal(ctl.auth.checkTotp(null), false);
});

test('lockouts: five failures lock a route, every route (passkey, pairing, backup) is separate, success resets', async () => {
  const { auth, store, tick } = await setup();
  for (let i = 1; i < MAX_FAILS; i++) assert.equal(auth.fail('backup', 'x'), 0);
  assert.equal(auth.fail('backup', 'x'), 60000);
  assert.equal(auth.lockedFor('backup'), 60000);
  assert.equal(auth.lockedFor('passkey'), 0, 'a guessed Mac name cannot lock the owner out');
  assert.equal(auth.fail('backup', 'x'), 120000, 'doubles');
  assert.ok(store.config.log.some(e => e.kind === 'lockout'));
  // Wrong codes from someone holding a pairing link lock pairing only, never the owner's passkeys.
  for (let i = 0; i < MAX_FAILS; i++) auth.fail('pair', 'x');
  assert.equal(auth.lockedFor('pair'), 60000);
  assert.equal(auth.lockedFor('passkey'), 0);
  for (let i = 0; i < MAX_FAILS; i++) auth.fail('passkey', 'x');
  assert.equal(auth.lockedFor('passkey'), 60000);
  tick(60001);
  assert.equal(auth.lockedFor('passkey'), 0);
  auth.succeed('passkey');
  assert.deepEqual(store.limit('passkey'), { fails: 0, lockedUntil: 0 });
  // Counters survive a restart (they live in config.json).
  const again = await Store.open({ home: store.home, secrets: 'file' });
  assert.equal(again.limit('backup').fails, MAX_FAILS + 1);
});

test('backup password (OPAQUE): right password gives the same key on both sides, wrong one fails', async () => {
  const { auth, store } = await setup();
  await opaque.ready;
  const password = 'amber otter lunar plum swift';
  const reg = opaque.client.startRegistration({ password });
  const { registrationResponse } = auth.backupRegisterStart(reg.registrationRequest);
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState: reg.clientRegistrationState, registrationResponse, password,
  });
  auth.backupRegisterFinish(registrationRecord);
  assert.equal(store.settings.backupOn, true);
  assert.equal(store.config.backup.record, registrationRecord);
  assert.ok(!JSON.stringify(store.config).includes(password));

  const login = (pw) => {
    const c = opaque.client.startLogin({ password: pw });
    const s = auth.opaqueLoginStart(c.startLoginRequest);
    const fin = opaque.client.finishLogin({ clientLoginState: c.clientLoginState, loginResponse: s.loginResponse, password: pw });
    return { s, fin };
  };
  const ok = login(password);
  assert.ok(ok.fin);
  const key = auth.opaqueLoginFinish(ok.s.serverLoginState, ok.fin.finishLoginRequest);
  assert.ok(equalBytes(key, fromB64url(ok.fin.sessionKey)));
  assert.equal(key.length, 64);

  const bad = login(password + '!');
  assert.equal(bad.fin, undefined, 'the client finds out on its own');
  // A forged finish message doesn't produce a key.
  const again = login(password);
  assert.equal(auth.opaqueLoginFinish(again.s.serverLoginState, toB64url(randomBytes(64))), null);
  assert.equal(auth.opaqueLoginStart('not base64!'), null);
  assert.throws(() => auth.backupRegisterStart(''), /not valid/);
  assert.throws(() => auth.backupRegisterFinish(42), /not valid/);
});

test('the OPAQUE server setup is made once and kept', async () => {
  const { store } = await setup();
  const first = store.opaqueServerSetup;
  assert.ok(first && first.length > 100);
  const store2 = await Store.open({ home: store.home, secrets: 'file' });
  const auth2 = new Auth({ store: store2, config });
  await auth2.init();
  assert.equal(store2.opaqueServerSetup, first);
});

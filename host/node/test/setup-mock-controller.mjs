// A stand-in for the host controller (host/node/src/controller.mjs), for testing the Setup page and its server on
// their own. It implements the whole controller interface in memory, with real authenticator codes (src/totp.mjs)
// and a real OPAQUE server (@serenity-kit/opaque), plus `mock.*` hooks a test uses to play the Mac's side: a device
// finishing pairing, someone signing in, a permission being switched on.
//
// Run it on its own to look at Setup in a browser:   node test/setup-mock-controller.mjs [--port 8790] [--full]
// (--full starts with everything set up: devices, a session, backup sign-in and some activity.)
import * as opaque from '@serenity-kit/opaque';
import { newSecret, base32, otpauthUri, checkCode } from '../src/totp.mjs';
import { newMacName, suggestPassword } from '../src/names.mjs';
import { normalizeMacName } from '../../../site/js/shared/rendezvous.js';
import { toB64url, randomBytes } from '../../../site/js/shared/bytes.js';
import { CONNECT_URL, PAIR_TTL_MS, DEFAULT_QUALITY } from '../../../site/js/shared/proto.js';

const IDLE_CHOICES = [15, 30, 60, 120, 0]; // 0 = never
const QUALITIES = ['smooth', 'balanced', 'sharp'];
const iso = (ms = Date.now()) => new Date(ms).toISOString();

export async function createMockController({ version = '0.1.0', test = true, macName = 'amber-otter-4821' } = {}) {
  await opaque.ready;
  const listeners = new Set();
  const calls = [];        // [name, ...args] for every interface call, so tests can check what the page asked for
  const failures = new Map(); // method name -> message to throw once

  const s = {
    macName,
    stateOverride: null,
    offline: false,
    permissions: { screen: false, accessibility: false },
    displays: [{ id: 1, name: 'Built-in Display', width: 3024, height: 1964, main: true }],
    settings: { loginItem: true, keepAwake: true, backupOn: false, idleMinutes: 60, paused: false, quality: DEFAULT_QUALITY },
    loginItem: { on: true, status: 'enabled' },
    totp: { secret: null, setAt: null, lastStep: -1 },
    pendingTotp: null,
    backup: { record: null, setAt: null },
    opaqueServerSetup: opaque.server.createSetup(),
    devices: [],
    pairing: null,
    session: null,
    activity: [],
    update: null,
    availableUpdate: null,
    inputEcho: [],
    uninstalled: false,
  };

  const changed = () => { for (const fn of [...listeners]) { try { fn(); } catch {} } };
  const note = (kind, text) => { s.activity.unshift({ at: iso(), kind, text }); s.activity.length = Math.min(s.activity.length, 50); };
  const call = (name, ...args) => {
    calls.push([name, ...args]);
    if (failures.has(name)) {
      const msg = failures.get(name);
      failures.delete(name);
      throw new Error(msg);
    }
  };

  function overall() {
    if (s.stateOverride) return s.stateOverride;
    if (s.offline) return { state: 'offline', stateText: 'Can\'t reach the internet. Perch will keep trying.' };
    if (s.settings.paused) return { state: 'paused', stateText: 'Paused: nobody can connect until you resume.' };
    if (s.session) return { state: 'connected', stateText: `${s.session.viewer} is connected.` };
    if (!s.totp.secret || s.devices.length === 0) return { state: 'needs-setup', stateText: 'Finish setting up to connect.' };
    return { state: 'ready', stateText: 'Ready: your devices can connect.' };
  }

  const controller = {
    state() {
      return {
        version,
        macName: s.macName,
        ...overall(),
        rendezvous: [
          { url: 'ws://127.0.0.1:1/mqtt', connected: !s.offline },
          { url: 'ws://127.0.0.1:2/mqtt', connected: !s.offline },
        ],
        permissions: { ...s.permissions },
        displays: s.displays.map(d => ({ ...d })),
        settings: { ...s.settings },
        loginItem: { ...s.loginItem },
        totp: { set: !!s.totp.secret, setAt: s.totp.setAt },
        backup: { set: !!s.backup.record, on: !!s.backup.record && s.settings.backupOn, setAt: s.backup.setAt },
        devices: s.devices.map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt })),
        pairing: s.pairing && { link: s.pairing.link, expiresAt: s.pairing.expiresAt },
        session: s.session && { ...s.session },
        activity: s.activity.slice(0, 50).map(a => ({ ...a })),
        update: s.update && { ...s.update },
        test,
      };
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    totpStart() {
      call('totpStart');
      const secret = newSecret();
      s.pendingTotp = secret;
      return { uri: otpauthUri(secret, s.macName), secret: base32(secret) };
    },

    totpConfirm(code) {
      call('totpConfirm', code);
      if (!s.pendingTotp) throw new Error('Start again: press "Set up" to get a new code.');
      const step = checkCode(s.pendingTotp, String(code).replace(/\s/g, ''));
      if (step === null) throw new Error('That code didn\'t match. Check the code in your authenticator app and try again.');
      s.totp = { secret: s.pendingTotp, setAt: iso(), lastStep: step };
      s.pendingTotp = null;
      note('settings', 'Authenticator app set up');
      changed();
      return { ok: true };
    },

    pairStart() {
      call('pairStart');
      if (!s.totp.secret) throw new Error('Set up the authenticator app first.');
      const link = `${CONNECT_URL}#pair=${toB64url(randomBytes(96))}`;
      s.pairing = { link, expiresAt: Date.now() + PAIR_TTL_MS };
      changed();
      return { link, expiresAt: s.pairing.expiresAt };
    },

    pairCancel() {
      call('pairCancel');
      s.pairing = null;
      changed();
    },

    deviceRename(id, label) {
      call('deviceRename', id, label);
      const d = s.devices.find(x => x.id === id);
      if (!d) throw new Error('That device isn\'t paired any more.');
      // As the real controller: control characters dropped, 1 to 64 characters.
      const clean = String(label).replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (!clean || clean.length > 64) throw new Error('Give the device a name of 1 to 64 characters.');
      d.label = clean;
      changed();
      return { id: d.id, label: d.label, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt };
    },

    deviceRemove(id) {
      call('deviceRemove', id);
      const before = s.devices.length;
      const d = s.devices.find(x => x.id === id);
      s.devices = s.devices.filter(x => x.id !== id);
      if (s.session?.deviceId === id) s.session = null;
      if (d) note('device', `Removed ${d.label}`);
      changed();
      return s.devices.length < before;
    },

    devicesRemoveAll() {
      call('devicesRemoveAll');
      s.devices = [];
      if (s.session?.deviceId) s.session = null;
      note('device', 'Removed every device');
      changed();
    },

    suggestPassword() {
      call('suggestPassword');
      return suggestPassword();
    },

    backupRegisterStart(registrationRequest) {
      call('backupRegisterStart', registrationRequest);
      const { registrationResponse } = opaque.server.createRegistrationResponse({
        serverSetup: s.opaqueServerSetup, userIdentifier: normalizeMacName(s.macName), registrationRequest,
      });
      return { registrationResponse };
    },

    backupRegisterFinish(registrationRecord) {
      call('backupRegisterFinish', registrationRecord);
      if (typeof registrationRecord !== 'string' || registrationRecord.length < 100) throw new Error('That password couldn\'t be saved. Please try again.');
      s.backup = { record: registrationRecord, setAt: iso() };
      s.settings.backupOn = true;
      note('settings', 'Backup password set; backup sign-in is on');
      changed();
      return { ok: true };
    },

    backupRemove() {
      call('backupRemove');
      s.backup = { record: null, setAt: null };
      s.settings.backupOn = false;
      note('settings', 'Backup password removed; backup sign-in is off');
      changed();
    },

    updateSettings(patch) {
      call('updateSettings', patch);
      const next = { ...s.settings };
      for (const [k, v] of Object.entries(patch ?? {})) {
        if (!(k in next)) throw new Error(`Unknown setting ${k}.`);
        if (k === 'idleMinutes') { if (!IDLE_CHOICES.includes(v)) throw new Error('Choose one of the listed times.'); }
        else if (k === 'quality') { if (!QUALITIES.includes(v)) throw new Error('Choose Smooth, Balanced or Sharp.'); }
        else if (typeof v !== 'boolean') throw new Error(`Bad value for ${k}.`);
        if (k === 'backupOn' && v && !s.backup.record) throw new Error('Set a backup password first.');
        next[k] = v;
      }
      s.settings = next;
      if ('loginItem' in (patch ?? {})) s.loginItem = { on: next.loginItem, status: next.loginItem ? 'enabled' : 'not-registered' };
      if (next.paused && s.session) s.session = null;
      changed();
      return { ...s.settings };
    },

    disconnect() {
      call('disconnect');
      if (s.session) note('session', `Disconnected ${s.session.viewer}`);
      s.session = null;
      changed();
    },

    requestPermission(which) {
      call('requestPermission', which);
      if (which !== 'screen' && which !== 'accessibility') throw new Error('Unknown permission.');
    },

    newMacName() {
      call('newMacName');
      s.macName = newMacName();
      s.backup = { record: null, setAt: null };
      s.settings.backupOn = false;
      note('settings', `Mac renamed to ${s.macName}`);
      changed();
      return s.macName;
    },

    reset() {
      call('reset');
      s.macName = newMacName();
      s.totp = { secret: null, setAt: null, lastStep: -1 };
      s.pendingTotp = null;
      s.backup = { record: null, setAt: null };
      s.opaqueServerSetup = opaque.server.createSetup();
      s.devices = [];
      s.pairing = null;
      s.session = null;
      s.activity = [];
      s.settings = { ...s.settings, backupOn: false, paused: false };
      changed();
    },

    uninstall() {
      call('uninstall');
      s.uninstalled = true;
      changed();
    },

    checkForUpdates() {
      call('checkForUpdates');
      s.update = s.availableUpdate;
      changed();
      return s.update;
    },

    installUpdate() {
      call('installUpdate');
      if (!s.update) throw new Error('There\'s no update to install.');
    },

    testInputEcho() {
      if (!test) throw new Error('Only in test mode.');
      return s.inputEcho.slice();
    },
  };

  // --- hooks for tests: things the Mac or a viewer would do ---
  const mock = {
    calls,
    get listenerCount() { return listeners.size; },
    get pendingTotpSecret() { return s.pendingTotp; },
    get totpSecret() { return s.totp.secret; },
    get backupRecord() { return s.backup.record; },
    get opaqueServerSetup() { return s.opaqueServerSetup; },
    get uninstalled() { return s.uninstalled; },
    get raw() { return s; },
    failNext(method, message) { failures.set(method, message); },
    callsOf(name) { return calls.filter(c => c[0] === name); },
    setPermissions(p) { Object.assign(s.permissions, p); changed(); },
    setOffline(on) { s.offline = on; changed(); },
    setStateOverride(v) { s.stateOverride = v; changed(); },
    setLoginItem(v) { s.loginItem = { ...v }; changed(); },
    setAvailableUpdate(u) { s.availableUpdate = u; },
    addDevice(label, { createdAt = iso(), lastUsedAt = null } = {}) {
      const d = { id: toB64url(randomBytes(16)), label, createdAt, lastUsedAt };
      s.devices.push(d);
      changed();
      return d;
    },
    // A device scanned the pairing code, made a passkey and typed the right code.
    completePairing(label = 'Safari on iPhone') {
      if (!s.pairing) throw new Error('no pairing in progress');
      s.pairing = null;
      const d = { id: toB64url(randomBytes(16)), label, createdAt: iso(), lastUsedAt: iso() };
      s.devices.push(d);
      note('pairing', `New device paired: ${label}`);
      changed();
      return d;
    },
    signIn({ viewer = 'Safari on iPhone', route = 'passkey', deviceId = s.devices[0]?.id ?? null } = {}) {
      s.session = { viewer, route, since: iso(), deviceId };
      const d = s.devices.find(x => x.id === deviceId);
      if (d) d.lastUsedAt = iso();
      note('sign-in', `Signed in with ${route === 'backup' ? 'the backup password' : 'a passkey'}: ${viewer}`);
      changed();
    },
    failedAttempt(text = 'Wrong 6-digit code from Chrome on Windows') { note('failure', text); changed(); },
    note(kind, text, at) { s.activity.unshift({ at: at ?? iso(), kind, text }); changed(); },
    echo(ev) { s.inputEcho.push(ev); },
    changed,
  };

  return { controller, mock };
}

// Everything set up, for screenshots and for trying the page by hand.
export function fillMock(mock) {
  const s = mock.raw;
  const day = 24 * 3600 * 1000;
  s.permissions = { screen: true, accessibility: true };
  s.totp = { secret: newSecret(), setAt: iso(Date.now() - 9 * day), lastStep: -1 };
  mock.addDevice('Safari on iPhone', { createdAt: iso(Date.now() - 9 * day), lastUsedAt: iso(Date.now() - 4 * 60 * 1000) });
  mock.addDevice('Chrome on the work laptop', { createdAt: iso(Date.now() - 3 * day), lastUsedAt: iso(Date.now() - day - 3 * 3600 * 1000) });
  mock.addDevice('iPad', { createdAt: iso(Date.now() - 2 * 3600 * 1000) });
  mock.note('pairing', 'New device paired: Safari on iPhone', iso(Date.now() - 9 * day));
  mock.note('sign-in', 'Signed in with a passkey: Chrome on the work laptop', iso(Date.now() - day - 3 * 3600 * 1000));
  mock.note('failure', 'Wrong 6-digit code from Firefox on Windows', iso(Date.now() - 50 * 60 * 1000));
  mock.signIn({ viewer: 'Safari on iPhone', route: 'passkey', deviceId: s.devices[0].id });
}

// `node test/setup-mock-controller.mjs` serves Setup with this mock so it can be tried in a browser.
if (import.meta.main) {
  const { startSetupServer } = await import('../src/setup-server.mjs');
  const args = process.argv.slice(2);
  const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 0;
  const { controller, mock } = await createMockController();
  if (args.includes('--full')) fillMock(mock);
  mock.setAvailableUpdate({ version: '0.2.0', url: 'https://github.com/Just-Rice/perch/releases/tag/v0.2.0', notes: 'Smoother video on slow networks.' });
  const srv = await startSetupServer({ controller, port, log: (m) => console.error(m) });
  console.log(`Setup (mock Mac) at ${srv.url}`);
  console.log('Ctrl-C to stop.');
  process.on('SIGINT', async () => { await srv.close(); process.exit(0); });
}

// The host controller: the one object that knows everything about this Mac's Perch and can change it. The Setup
// page (src/setup-server.mjs), the menu bar (via the app's 'menu' events) and the tests all go through it.
//
// It owns the sessions: it creates them for signaling, picks the one signed-in viewer that gets the picture, feeds
// that viewer the app's video and sound, and passes that viewer's (already checked) input to the app. All methods
// may be async; errors are thrown as Error with a plain-language message safe to show the user.
import { QUALITY, DEFAULT_QUALITY, PAIR_TTL_MS, AUTH_TIMEOUT_MS } from '../../../site/js/shared/proto.js';
import { newMacName as makeMacName, suggestPassword } from './names.mjs';
import { HostPeer } from './rtc.mjs';
import { Session } from './session.mjs';
import { Relay } from './relay.mjs';
import { Signaling } from './signaling.mjs';
import { silentLog } from './log.mjs';

const ACTIVITY_SHOWN = 50;
const ECHO_KEEP = 500;
const BYE_TEXT = {
  'signed-in-elsewhere': 'another device signed in', paused: 'Perch was paused', quit: 'Perch quit', idle: 'no input for a while',
  removed: 'the device was removed', disconnected: 'disconnected', bye: 'the viewer left', denied: 'sign-in refused',
};
const CAPTURE_ERRORS = ['no-screen-permission', 'capture-failed'];

const publicDevice = d => ({ id: d.id, label: d.label, createdAt: d.createdAt ?? null, lastUsedAt: d.lastUsedAt ?? null });

function cleanDisplays(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(d => d && Number.isFinite(d.id)).slice(0, 16).map(d => ({
    id: d.id,
    name: typeof d.name === 'string' ? d.name.slice(0, 64) : `Display ${d.id}`,
    width: Number.isFinite(d.width) ? d.width : 0,
    height: Number.isFinite(d.height) ? d.height : 0,
    main: !!d.main,
  }));
}

export class Controller {
  constructor({ config, store, auth, rendezvous, app, log = silentLog(), updater = null, now = () => Date.now(),
    authTimeoutMs = AUTH_TIMEOUT_MS, relay = null }) {
    Object.assign(this, { config, store, auth, rendezvous, app, log, updater, now, authTimeoutMs });
    this.signaling = new Signaling({ rendezvous, hub: this, log: log.child('rendezvous'), now });
    this.relay = relay ?? new Relay({ store, log: log.child('relay'), now });
    this.sessions = new Set();
    this.active = null;
    this.listeners = new Set();
    this.changeQueued = false;
    this.started = false;
    this.fatal = null;
    this.setupUrl = null;
    this.update = null;
    this.onQuit = () => {};
    // What the app has told us (HELLO and events).
    this.appInfo = null;
    this.permissions = { screen: false, accessibility: false };
    this.displays = [];
    this.loginItemState = { on: false, status: 'unknown' };
    this.locked = false;
    this.capture = null;
    this.captureOn = false;
    this.inputEcho = [];
    this.pairTimer = null;
  }

  // Connects the signaling topics for the current identity. Call once the store and auth are ready.
  async start() {
    await this.signaling.setHost(this.store.hostId, this.store.sigKey);
    await this._applyListening();
    this.started = true;
    this._changed();
  }

  // The version viewers and the update check see is the app's (HELLO), or what the app put in our environment.
  get hv() { return this.appInfo?.version ?? this.config.appVersion ?? this.config.version; }

  // --- change notification ---

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Coalesces bursts of changes into one notification.
  _changed() {
    if (this.changeQueued) return;
    this.changeQueued = true;
    setImmediate(() => {
      this.changeQueued = false;
      for (const fn of [...this.listeners]) {
        try { fn(); } catch (e) { this.log.error('change listener failed:', e); }
      }
    });
  }

  // --- state ---

  stateName() {
    if (this.fatal) return 'error';
    if (!this.started) return 'starting';
    if (this.active) return 'connected';
    if (this.store.settings.paused) return 'paused';
    if (this.rendezvous.connectedCount === 0) return 'offline';
    if (!this.store.config.totp.set || this.store.devices.length === 0) return 'needs-setup';
    return 'ready';
  }

  stateText(state = this.stateName()) {
    switch (state) {
      case 'error': return this.fatal;
      case 'starting': return 'Starting…';
      case 'connected': return `${this.active.label} is connected`;
      case 'paused': return 'Paused: nobody can connect';
      case 'offline': return 'Offline: can’t reach the internet. Retrying…';
      case 'needs-setup': return !this.store.config.totp.set ? 'Finish setting up: add Perch to your authenticator app'
        : 'Finish setting up: pair a phone or computer';
      default: return 'Ready: open just-rice.github.io/perch to connect';
    }
  }

  state() {
    const s = this.store;
    const state = this.stateName();
    const a = this.active;
    return {
      version: this.hv,
      macName: s.macName,
      state,
      stateText: this.stateText(state),
      rendezvous: this.rendezvous.status(),
      permissions: { ...this.permissions },
      displays: this.displays.map(d => ({ ...d })),
      settings: { ...s.settings },
      loginItem: { on: !!this.loginItemState.on, status: this.loginItemState.status ?? 'unknown' },
      totp: { set: !!s.config.totp.set, setAt: s.config.totp.setAt ?? null },
      backup: { set: !!s.config.backup.record, on: !!s.settings.backupOn, setAt: s.config.backup.setAt ?? null },
      relay: this.relay.state(),
      devices: s.devices.map(publicDevice),
      pairing: this.auth.pairingInfo(),
      session: a ? { viewer: a.label, route: a.route, since: new Date(a.signedInAt).toISOString(), deviceId: a.deviceId } : null,
      activity: s.config.log.slice(-ACTIVITY_SHOWN).reverse(),
      update: this.update,
      test: !!this.config.test,
    };
  }

  // What the menu bar shows (the 'status' command).
  statusCommand() {
    const state = this.stateName();
    return {
      state, text: this.stateText(state), macName: this.store.macName, setupUrl: this.setupUrl,
      settings: { ...this.store.settings }, ...(this.update ? { update: this.update } : {}),
    };
  }

  setSetupUrl(url) { this.setupUrl = url; this._changed(); }
  setFatal(text) { this.fatal = text; this._changed(); }

  // --- the app ---

  handleHello(h) {
    this.appInfo = {
      app: String(h.app ?? ''), version: typeof h.version === 'string' ? h.version : null,
      macos: String(h.macos ?? ''), synthetic: !!h.synthetic,
    };
    if (h.permissions) this.permissions = { screen: !!h.permissions.screen, accessibility: !!h.permissions.accessibility };
    this.displays = cleanDisplays(h.displays);
    if (h.loginItem && typeof h.loginItem === 'object') this.loginItemState = { on: !!h.loginItem.on, status: String(h.loginItem.status ?? 'unknown') };
    this.log.info(`app ${this.appInfo.app} ${this.appInfo.version} on macOS ${this.appInfo.macos}${this.appInfo.synthetic ? ' (synthetic)' : ''}`);
    // The app starts with everything off; apply what the user chose.
    this.app.command('keep-awake', { on: !!this.store.settings.keepAwake });
    this.app.command('login-item', { on: !!this.store.settings.loginItem });
    this._changed();
  }

  handleEvent(ev) {
    switch (ev.e) {
      case 'permissions':
        this.permissions = { screen: !!ev.screen, accessibility: !!ev.accessibility };
        this.active?.sendStatus();
        break;
      case 'displays':
        this.displays = cleanDisplays(ev.displays);
        break;
      case 'capture-started':
        this.capture = { display: ev.display, width: ev.width | 0, height: ev.height | 0, fps: ev.fps | 0 };
        this.active?.sendStatus();
        break;
      case 'capture-stopped':
        this.capture = null;
        break;
      case 'capture-error': {
        const code = CAPTURE_ERRORS.includes(ev.code) ? ev.code : 'capture-failed';
        this.log.warn(`capture error: ${code} ${ev.message ?? ''}`);
        this.active?.sendError(code, typeof ev.message === 'string' ? ev.message.slice(0, 200) : 'The Mac could not capture the screen.');
        break;
      }
      case 'lock':
        this.locked = !!ev.locked;
        this.active?.sendStatus();
        break;
      case 'login-item':
        this.loginItemState = { on: !!ev.on, status: String(ev.status ?? 'unknown'), ...(ev.error ? { error: String(ev.error) } : {}) };
        if (ev.error) this.log.warn(`login item: ${ev.error}`);
        break;
      case 'menu':
        this._menu(ev.action).catch(e => this._notify('Perch', e.message));
        return;
      case 'input-echo':
        if (this.config.test) {
          this.inputEcho.push(ev.ev);
          if (this.inputEcho.length > ECHO_KEEP) this.inputEcho.splice(0, this.inputEcho.length - ECHO_KEEP);
        }
        return;
      case 'log': {
        const lvl = ['debug', 'info', 'warn', 'error'].includes(ev.level) ? ev.level : 'info';
        this.log[lvl](`app: ${String(ev.message ?? '').slice(0, 2000)}`);
        return;
      }
      default:
        this.log.debug(`app event ${ev.e} ignored`);
        return;
    }
    this._changed();
  }

  // Media from the app goes to the signed-in viewer only, and only once it is signed in.
  handleVideo(frame) { if (this.active?.signedIn) this.active.pushVideo(frame); }
  handleAudio(frame) { if (this.active?.signedIn) this.active.pushAudio(frame); }

  _notify(title, body) { this.app.command('notify', { title, body }); }

  async _menu(action) {
    switch (action) {
      case 'pause': return this.updateSettings({ paused: true });
      case 'resume': return this.updateSettings({ paused: false });
      case 'disconnect': return this.disconnect();
      case 'backup-on':
        if (!this.store.config.backup.record) {
          this._notify('Backup sign-in', 'Choose a backup password in Setup first.');
          if (this.setupUrl) this.app.command('open-url', { url: this.setupUrl });
          return;
        }
        return this.updateSettings({ backupOn: true });
      case 'backup-off': return this.updateSettings({ backupOn: false });
      case 'keep-awake-on': return this.updateSettings({ keepAwake: true });
      case 'keep-awake-off': return this.updateSettings({ keepAwake: false });
      case 'login-item-on': return this.updateSettings({ loginItem: true });
      case 'login-item-off': return this.updateSettings({ loginItem: false });
      case 'check-updates': {
        const u = await this.checkForUpdates();
        return this._notify('Perch', u ? `Perch ${u.version} is available.` : 'Perch is up to date.');
      }
      case 'update': return this.installUpdate();
      case 'quit': return this.onQuit();
      default: this.log.debug(`menu action ${action} ignored`);
    }
  }

  // --- the hub, for src/signaling.mjs ---

  refusal(hello) {
    const s = this.store;
    if (s.settings.paused) return { reason: 'paused' };
    if (!s.config.totp.set) return { reason: 'not-set-up' };
    if (hello.route === 'passkey' && s.devices.length === 0) return { reason: 'not-set-up' };
    if (hello.route === 'backup' && (!s.settings.backupOn || !s.config.backup.record)) return { reason: 'backup-off' };
    const locked = this.auth.lockedFor(hello.route);
    if (locked > 0) return { reason: 'locked-out', retryAfter: Math.ceil(locked / 1000) };
    return null;
  }

  unauthenticatedCount() {
    let n = 0;
    for (const s of this.sessions) if (s.state !== 'ready' && s.state !== 'ended') n++;
    return n;
  }

  createSession(hello) {
    const peer = new HostPeer({ iceServers: this.config.iceServers, iceLoopback: this.config.iceLoopback, log: this.log.child('rtc') });
    const session = new Session({
      sid: hello.sid, route: hello.route, label: hello.label, peer, auth: this.auth, store: this.store, hub: this,
      log: this.log.child(`session ${hello.sid.slice(0, 6)}`), now: this.now, authTimeoutMs: this.authTimeoutMs,
    });
    this.sessions.add(session);
    this._changed();
    return session;
  }

  // --- the hub, for src/session.mjs ---

  hasDisplay(id) { return this.displays.some(d => d.id === id); }

  _display(id) {
    return this.displays.find(d => d.id === id) ?? this.displays.find(d => d.main) ?? this.displays[0]
      ?? { id: 0, name: 'Display', width: 0, height: 0, main: true };
  }

  _sendCapture(session) {
    const preset = QUALITY[session.quality] ?? QUALITY[DEFAULT_QUALITY];
    this.captureOn = true;
    this.app.command('capture', {
      on: true, display: this._display(session.display).id, maxEdge: preset.maxEdge, fps: preset.fps, kbps: preset.kbps, audio: true,
    });
  }

  // A viewer just finished signing in: it takes over from any other viewer and gets the picture.
  sessionSignedIn(session) {
    const old = this.active;
    this.active = session;
    if (old && old !== session) old.end('signed-in-elsewhere');
    const quality = Object.hasOwn(QUALITY, this.store.settings.quality) ? this.store.settings.quality : DEFAULT_QUALITY;
    const display = this._display(old?.display);
    session.quality = quality;
    session.display = display.id;
    this.app.command('session', { active: true, viewer: session.label, route: session.route });
    this._sendCapture(session);
    this._changed();
    return {
      display: { id: display.id, width: display.width, height: display.height },
      displays: this.displays.map(d => ({ ...d })),
      quality, audio: true, input: !!this.permissions.accessibility, locked: !!this.locked,
    };
  }

  captureChanged(session) {
    if (session === this.active) this._sendCapture(session);
  }

  keyframe(session) {
    if (session === this.active) this.app.command('keyframe', {});
  }

  bitrate(session, kbps) {
    if (session === this.active) this.app.command('bitrate', { kbps });
  }

  // Input reaches the app only from the active, signed-in viewer, and only if the Mac allows Perch to control it.
  input(session, msg) {
    if (session !== this.active || !session.signedIn || !this.permissions.accessibility) return false;
    return this.app.input(msg) !== false;
  }

  sessionEnded(session, reason, wasReady) {
    this.sessions.delete(session);
    if (this.active === session) {
      this.active = null;
      this.captureOn = false;
      this.capture = null;
      this.app.command('capture', { on: false });
      this.app.command('session', { active: false });
    }
    if (wasReady && reason !== 'signed-in-elsewhere') {
      this.store.activity('session', `${session.label} disconnected (${BYE_TEXT[reason] ?? reason})`);
    }
    this._changed();
  }

  _endSessions(pred, reason) {
    for (const s of [...this.sessions]) if (pred(s)) s.end(reason);
  }

  async _applyListening() {
    const s = this.store;
    await this.signaling.setName(s.settings.backupOn && s.config.backup.record ? s.macName : null);
  }

  // --- the controller interface ---

  totpStart() {
    return this.auth.totpStart();
  }

  async totpConfirm(code) {
    const r = await this.auth.totpConfirm(code);
    this._changed();
    return r;
  }

  pairStart() {
    const info = this.auth.createPairing();
    clearTimeout(this.pairTimer);
    this.pairTimer = setTimeout(() => this._changed(), PAIR_TTL_MS + 100);
    this.pairTimer.unref?.();
    this._changed();
    return info;
  }

  pairCancel() {
    this.auth.cancelPairing();
    clearTimeout(this.pairTimer);
    this._changed();
  }

  deviceRename(id, label) {
    const clean = typeof label === 'string' ? label.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    if (!clean || clean.length > 64) throw new Error('Give the device a name of 1 to 64 characters.');
    const d = this.store.updateDevice(id, { label: clean });
    if (!d) throw new Error('That device is not paired any more.');
    this._changed();
    return publicDevice(d);
  }

  deviceRemove(id) {
    const d = this.store.findDevice(id);
    const ok = this.store.removeDevice(id);
    if (ok) {
      this.store.activity('device', `Removed ${d.label}`);
      this._endSessions(s => s.deviceId === id, 'removed');
    }
    this._changed();
    return ok;
  }

  devicesRemoveAll() {
    const n = this.store.devices.length;
    this.store.removeAllDevices();
    if (n) this.store.activity('device', `Removed all ${n} devices`);
    this._endSessions(s => s.deviceId !== null, 'removed');
    this._changed();
  }

  suggestPassword() {
    return suggestPassword();
  }

  backupRegisterStart(registrationRequest) {
    return this.auth.backupRegisterStart(registrationRequest);
  }

  async backupRegisterFinish(registrationRecord) {
    this.auth.backupRegisterFinish(registrationRecord);
    await this._applyListening();
    this._changed();
    return { ok: true };
  }

  // --- the optional relay for strict networks ---

  // Relay logins for an offer (signaling.mjs); [] without a relay.
  relayIceServers() { return this.relay.iceServers(); }

  async relaySet(keyId, apiToken) {
    const replacing = this.relay.configured;
    await this.relay.save(keyId, apiToken);
    this.store.activity('settings', replacing ? 'Relay key replaced' : 'Relay for strict networks set up');
    this._changed();
    return { ok: true };
  }

  async relayRemove() {
    if (this.relay.configured) this.store.activity('settings', 'Relay for strict networks removed');
    await this.relay.remove();
    this._changed();
  }

  async backupRemove() {
    if (this.store.config.backup.record) this.store.activity('settings', 'Backup password removed; backup sign-in is off');
    this.store.setBackupRecord(null);
    this._endSessions(s => s.route === 'backup', 'removed');
    await this._applyListening();
    this._changed();
  }

  async updateSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings must be an object.');
    const s = this.store;
    for (const [k, v] of Object.entries(patch)) {
      switch (k) {
        case 'loginItem': case 'keepAwake': case 'backupOn': case 'paused':
          if (typeof v !== 'boolean') throw new Error(`${k} must be true or false.`);
          break;
        case 'idleMinutes':
          // Tests may use a fraction of a minute so the idle timeout can be seen in seconds.
          if (!(typeof v === 'number' && v <= 1440 && (this.config.test ? v > 0 : Number.isInteger(v) && v >= 1))) {
            throw new Error('The idle time must be a whole number of minutes from 1 to 1440.');
          }
          break;
        case 'quality':
          if (typeof v !== 'string' || !Object.hasOwn(QUALITY, v)) throw new Error(`Quality must be one of ${Object.keys(QUALITY).join(', ')}.`);
          break;
        default:
          throw new Error(`There is no setting called ${k}.`);
      }
    }
    if (patch.backupOn === true && !s.config.backup.record) throw new Error('Choose a backup password first.');
    const before = { ...s.settings };
    const after = s.updateSettings(patch);
    if (after.paused !== before.paused) {
      s.activity('settings', after.paused ? 'Paused: nobody can connect' : 'Resumed');
      if (after.paused) this._endSessions(() => true, 'paused');
    }
    if (after.backupOn !== before.backupOn) {
      s.activity('settings', after.backupOn ? 'Backup sign-in turned on' : 'Backup sign-in turned off');
      if (!after.backupOn) this._endSessions(x => x.route === 'backup' && !x.signedIn, 'removed');
      await this._applyListening();
    }
    if ('keepAwake' in patch) this.app.command('keep-awake', { on: after.keepAwake });
    if ('loginItem' in patch) this.app.command('login-item', { on: after.loginItem });
    this._changed();
    return { ...after };
  }

  disconnect() {
    this.active?.end('disconnected');
    this._changed();
  }

  requestPermission(which) {
    if (which !== 'screen' && which !== 'accessibility') throw new Error('Permission must be screen or accessibility.');
    this.app.command('request-permission', { which });
  }

  async newMacName() {
    const name = makeMacName();
    const hadBackup = !!this.store.config.backup.record;
    this._endSessions(s => s.route === 'backup', 'removed');
    this.store.setMacName(name);
    this.store.activity('settings', `Mac renamed to ${name}${hadBackup ? '; the backup password was removed' : ''}`);
    await this._applyListening();
    this._changed();
    return name;
  }

  // Forget everything: new id, name and keys, so every passkey and link made before stops working.
  async reset() {
    this._endSessions(() => true, 'removed');
    this.auth.cancelPairing();
    this.auth.pendingTotp = null;
    await this.store.reset();
    await this.auth.init();
    await this.signaling.setHost(this.store.hostId, this.store.sigKey);
    await this._applyListening();
    this.store.activity('settings', 'Perch was reset: new name and keys, no paired devices');
    this._changed();
  }

  async uninstall() {
    this._endSessions(() => true, 'quit');
    await this.signaling.close();
    await this.store.destroy();
    this.app.command('login-item', { on: false });
    this.app.command('uninstall', {});
    this.uninstalled = true;
    this._changed();
  }

  async checkForUpdates() {
    // Tests never ask GitHub: they must not depend on the network or on what has been released.
    if (!this.updater?.checkForUpdate || this.config.test) return null;
    const log = this.log.child('updater');
    try {
      this.update = (await this.updater.checkForUpdate(this.hv, { log: m => log.info(m) })) ?? null;
    } catch (e) {
      log.warn(`update check failed: ${e.message}`);
      throw new Error('Couldn’t check for updates. Check the internet connection and try again.');
    }
    this._changed();
    return this.update;
  }

  async installUpdate() {
    if (!this.updater?.installUpdate) throw new Error('This copy of Perch can’t update itself.');
    if (this.config.test) throw new Error('Updates are turned off in test mode.');
    const log = this.log.child('updater');
    return this.updater.installUpdate({ log: m => log.info(m) });
  }

  testInputEcho() {
    if (!this.config.test) throw new Error('Only available in test mode.');
    return [...this.inputEcho];
  }

  // Test mode only (GET /api/test/state on the Setup page): state() plus the inside view below.
  testState() {
    if (!this.config.test) throw new Error('Only available in test mode.');
    return { ...this.state(), debug: this.debug() };
  }

  // Test mode only: what the tests need to see beyond state().
  debug() {
    if (!this.config.test) throw new Error('Only available in test mode.');
    return {
      sessions: [...this.sessions].map(s => ({ sid: s.sid, route: s.route, state: s.state, step: s.step, stats: s.stats,
        media: s.media ? { ...s.media.totals } : null })),
      active: this.active?.sid ?? null,
      captureOn: this.captureOn,
      signaling: { ...this.signaling.stats, listening: this.signaling.listening },
      limits: JSON.parse(JSON.stringify(this.store.config.limits)),
      lastStep: this.store.config.totp.lastStep,
    };
  }

  // Ends every session (telling viewers why) and stops listening. Used when quitting.
  async shutdown(reason = 'quit') {
    this._endSessions(() => true, reason);
    clearTimeout(this.pairTimer);
    await this.signaling.close().catch(() => {});
  }
}

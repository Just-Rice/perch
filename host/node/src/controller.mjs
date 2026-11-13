// The host controller: the one object that knows everything about this Mac's Perch and can change it. The Setup
// page (src/setup-server.mjs), the menu bar (via the app's 'menu' events) and the tests all go through it.
//
// It owns the sessions: it creates them for signaling, picks the one signed-in viewer that gets the picture, feeds
// that viewer the app's video and sound, and passes that viewer's (already checked) input to the app. All methods
// may be async; errors are thrown as Error with a plain-language message safe to show the user.
import { QUALITY, DEFAULT_QUALITY, PAIR_TTL_MS, AUTH_TIMEOUT_MS } from '../../../site/js/shared/proto.js';
import { newMacName as makeMacName, suggestPassword } from './names.mjs';
import { normalizeMacName, CUSTOM_MAC_NAME_RE } from '../../../site/js/shared/rendezvous.js';
import { HostPeer, ensureDtlsIdentity } from './rtc.mjs';
import { Session } from './session.mjs';
import { Relay } from './relay.mjs';
import { WorkerRelay, WsPeer } from './wsrelay.mjs';
import { roomUrl, roomAuth, relayBroker } from '../../../site/js/shared/wsrelay.js';
import { Signaling } from './signaling.mjs';
import { silentLog } from './log.mjs';

const ACTIVITY_SHOWN = 50;
const ECHO_KEEP = 500;
const BYE_TEXT = {
  'signed-in-elsewhere': 'another device signed in', paused: 'Perch was paused', quit: 'Perch quit', idle: 'no input for a while',
  removed: 'the device was removed', disconnected: 'disconnected', bye: 'the viewer left', denied: 'sign-in refused',
};
const CAPTURE_ERRORS = ['no-screen-permission', 'capture-failed'];
const MAX_GUESTS = 3;

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

function cleanOutputs(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(d => d && typeof d.uid === 'string' && d.uid && d.uid.length <= 200).slice(0, 32).map(d => ({
    uid: d.uid, name: typeof d.name === 'string' ? d.name.slice(0, 80) : d.uid, main: !!d.main,
  }));
}

// What the app says about the windows on screen, trimmed to what a viewer's picker needs.
function cleanWindows(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(w => w && Number.isInteger(w.id) && w.id > 0).slice(0, 40).map(w => ({
    id: w.id,
    app: typeof w.app === 'string' ? w.app.slice(0, 80) : '',
    title: typeof w.title === 'string' ? w.title.slice(0, 160) : '',
    width: Number.isFinite(w.width) ? w.width : 0,
    height: Number.isFinite(w.height) ? w.height : 0,
  }));
}

export class Controller {
  constructor({ config, store, auth, rendezvous, app, log = silentLog(), updater = null, now = () => Date.now(),
    authTimeoutMs = AUTH_TIMEOUT_MS, relay = null }) {
    Object.assign(this, { config, store, auth, rendezvous, app, log, updater, now, authTimeoutMs });
    this.signaling = new Signaling({ rendezvous, hub: this, log: log.child('rendezvous'), now });
    this.relay = relay ?? new Relay({ store, log: log.child('relay'), now, serviceUrl: config.relayServiceUrl });
    this.workerRelay = new WorkerRelay({ store, log: log.child('worker-relay'), now, allowLocal: !!config?.test,
      ...(config?.relayFetch ? { fetchImpl: config.relayFetch } : {}) });
    this.sessions = new Set();
    this.active = null;
    this.guests = new Set();   // signed-in guests (view only), besides the one active viewer
    this.guestTimer = null;
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
    this.audioOutputs = [];    // the Mac's sound outputs, as the app lists them
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
    this.relay.warm(); // fetch relay logins now, so the first viewer's offer doesn't wait for them
    this.workerRelay.warm();
    this._useRelayBroker();
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
      workerRelay: this.workerRelay.state(),
      audioOutputs: this.audioOutputs.map(d => ({ ...d })),
      devices: s.devices.map(d => ({ ...publicDevice(d), site: this.auth.deviceRpId(d) })),
      sites: this.auth.sites().map(x => ({ origin: x.origin, url: x.url, builtIn: !!x.builtIn, addedAt: x.addedAt ?? null })),
      pairing: this.auth.pairingInfo(),
      guest: (g => g ? { ...g, watching: this.guests.size } : null)(this.auth.guestInfo()),
      session: a ? { viewer: a.label, route: a.route, since: new Date(a.signedInAt).toISOString(), deviceId: a.deviceId,
        transport: a.transport } : null,
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
      case 'permissions': {
        const hadScreen = this.permissions.screen;
        this.permissions = { screen: !!ev.screen, accessibility: !!ev.accessibility };
        // Screen Recording was just allowed while someone is waiting for a picture: start it now.
        if (!hadScreen && this.permissions.screen && this.active) this._sendCapture(this.active);
        this.active?.sendStatus();
        break;
      }
      case 'displays':
        this.displays = cleanDisplays(ev.displays);
        if (this.active) {
          // The display being shown was unplugged: carry on with the main one instead of a frozen picture.
          if (!this.hasDisplay(this.active.display)) {
            this.active.display = this._display(null).id;
            this._sendCapture(this.active);
          }
          this.active.sendStatus({ displays: this.displays.map(d => ({ ...d })), display: this.active.display });
        }
        break;
      case 'capture-started':
        this.capture = {
          display: ev.display, width: ev.width | 0, height: ev.height | 0, fps: ev.fps | 0,
          window: Number.isInteger(ev.window) && ev.window > 0 ? ev.window : null,
        };
        this.active?.sendStatus();
        break;
      case 'windows':
        // The answer to a viewer's "which windows are there?": only for the owner's own viewer, if still here.
        if (this.windowAsker && this.windowAsker === this.active) this.windowAsker.sendWindows(cleanWindows(ev.list));
        this.windowAsker = null;
        break;
      case 'window-gone':
        // The window being shown was closed or put away: the app is already showing the whole display again.
        if (this.active && this.active.window === ev.window) this.active.window = null;
        break;
      case 'window-fit':
        this.active?.sendFit(ev.ok === true);
        break;
      case 'clipboard':
        if (this.clipAsker && this.clipAsker === this.active) {
          this.clipAsker.sendClip(ev.text, ev.ok === true && typeof ev.text === 'string',
            { image: typeof ev.image === 'string' ? ev.image : null, auto: ev.auto === true });
        }
        this.clipAsker = null;
        break;
      case 'clipboard-changed':
        // Something was copied on the Mac: a viewer that asked for it gets it straight away.
        if (this.active && !this.active.guest && this.active.clipSync) {
          this.clipAsker = this.active;
          this.app.command('clipboard-get', { images: true, auto: true });
        }
        break;
      case 'clipboard-set':
        this.active?.sendClipSet(ev.ok === true);
        break;
      case 'text-focus':
        // A click just put the Mac's focus in a text box (or out of one): a phone can bring up its keyboard.
        this.active?.sendTextFocus(ev.editable === true, ev.secure === true);
        break;
      case 'audio-outputs':
        // Where the viewer's voice can be played: the Mac's sound outputs, for the picker in Setup.
        this.audioOutputs = cleanOutputs(ev.list);
        this._changed();
        break;
      case 'mic':
        // The app couldn't play the microphone (no such output any more): tell the viewer it is off.
        if (ev.ok === false && this.active?.micOn) {
          this.active.micOn = false;
          this.active.sendMic(false, typeof ev.error === 'string' ? ev.error.slice(0, 200) : undefined);
        }
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
  handleVideo(frame) {
    if (this.active?.signedIn) this.active.pushVideo(frame);
    for (const g of this.guests) g.pushVideo(frame);
  }
  handleAudio(frame) {
    if (this.active?.signedIn) this.active.pushAudio(frame);
    for (const g of this.guests) g.pushAudio(frame);
  }

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
    if (hello.route === 'guest') {
      if (!this.auth.guestInfo()) return { reason: 'link-expired' };
      return this.guests.size >= MAX_GUESTS ? { reason: 'busy', retryAfter: 30 } : null;
    }
    if (!s.config.totp.set) return { reason: 'not-set-up' };
    if (hello.route === 'passkey' && s.devices.length === 0) return { reason: 'not-set-up' };
    if (hello.route === 'backup' && (!s.settings.backupOn || !s.config.backup.record)) return { reason: 'backup-off' };
    const locked = this.auth.lockedFor(hello.route);
    if (locked > 0) return { reason: 'locked-out', retryAfter: Math.ceil(locked / 1000) };
    return null;
  }

  // Sessions still signing in, counted per topic ('host': passkey and pairing, 'name': backup), so strangers who only
  // know the Mac's name can't fill the slots the owner's own devices need.
  unauthenticatedCount(kind) {
    let n = 0;
    for (const s of this.sessions) {
      if (s.state === 'ready' || s.state === 'ended') continue;
      const k = s.route === 'backup' ? 'name' : s.route === 'guest' ? 'guest' : 'host';
      if (kind === undefined || kind === k) n++;
    }
    return n;
  }

  createSession(hello) {
    const peer = new HostPeer({ iceServers: this.config.iceServers, iceLoopback: this.config.iceLoopback,
      dtlsKeys: this.store.dtlsKeys, log: this.log.child('rtc') });
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
      on: true, display: this._display(session.display).id,
      // The size the link and the viewer's screen call for, and the bitrate the link is carrying right now (not the
      // preset's starting value, which would undo what bitrate control has learned).
      maxEdge: session.captureEdge?.() ?? preset.maxEdge, fps: preset.fps,
      kbps: session.media?.bitrate.target ?? preset.kbps, audio: true,
      ...(session.window ? { window: session.window } : {}),
    });
  }

  listWindows(session) {
    if (session !== this.active) return;
    this.windowAsker = session;
    this.app.command('windows', {});
  }

  clipGet(session, images = false) {
    if (session !== this.active) return;
    this.clipAsker = session;
    this.app.command('clipboard-get', images ? { images: true } : {});
  }

  // text and/or image (a base64 string of a picture file); either may be undefined.
  clipSet(session, text, paste, image) {
    if (session !== this.active) return;
    const cmd = { paste: !!paste };
    if (text !== undefined) cmd.text = text;
    if (image !== undefined) cmd.image = image;
    this.app.command('clipboard-set', cmd);
  }

  // The owner's viewer turned its microphone on or off. The app plays it on the output chosen in Setup.
  micChanged(session, on) {
    if (session !== this.active) return;
    this.app.command('mic', { on, ...(this.store.settings.micOutput ? { device: this.store.settings.micOutput } : {}) });
    this.store.activity('session', on ? `Microphone on: ${session.label}` : 'Microphone off');
    this._changed();
  }

  mic(session, seq, packet) {
    if (session === this.active) this.app.mic(seq, packet);
  }

  fitWindow(session, w, h) {
    if (session === this.active && session.window) this.app.command('window-fit', { window: session.window, w, h });
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
    this.app.command('session', { active: true, viewer: session.label, route: session.route, curtain: !!this.store.settings.curtain });
    this._sendCapture(session);
    this._changed();
    return {
      display: { id: display.id, width: display.width, height: display.height },
      displays: this.displays.map(d => ({ ...d })),
      quality, audio: true, input: !!this.permissions.accessibility, locked: !!this.locked,
      ...(this.workerRelay.base ? { relay: this.workerRelay.base } : {}),
    };
  }

  // Whoever sets the picture's size and bitrate: the owner's own viewer, or else the first guest.
  get leader() { return this.active ?? this.guests.values().next().value ?? null; }

  captureChanged(session) {
    if (session === this.leader) this._sendCapture(session);
  }

  // Any viewer may need a fresh picture to start from (a guest joining, a lost packet).
  keyframe(session) {
    if (session === this.active || this.guests.has(session)) this.app.command('keyframe', {});
  }

  bitrate(session, kbps) {
    if (session === this.leader) this.app.command('bitrate', { kbps });
  }

  // A guest finished joining: they get the same picture the owner's viewer gets (or the main display, if nobody
  // else is connected), and never any control.
  guestSignedIn(session) {
    this.guests.add(session);
    const leader = this.active;
    const quality = leader?.quality ?? (Object.hasOwn(QUALITY, this.store.settings.quality) ? this.store.settings.quality : DEFAULT_QUALITY);
    const display = this._display(leader?.display);
    session.quality = quality;
    session.display = display.id;
    if (!leader && this.guests.size === 1) {
      this.app.command('session', { active: true, viewer: 'A guest (view only)', route: 'guest', curtain: false });
      this._sendCapture(session);
    } else {
      this.app.command('keyframe', {});
    }
    this._notify('Perch', `A guest is watching this Mac's screen (${session.label}).`);
    this._changed();
    return {
      display: { id: display.id, width: display.width, height: display.height },
      displays: [{ ...display }], quality, audio: true, input: false, locked: !!this.locked, guest: true,
    };
  }

  // Input reaches the app only from the active, signed-in viewer, and only if the Mac allows Perch to control it.
  input(session, msg) {
    if (session !== this.active || !session.signedIn || !this.permissions.accessibility) return false;
    return this.app.input(msg) !== false;
  }

  sessionEnded(session, reason, wasReady) {
    this.sessions.delete(session);
    // Whoever was talking through the Mac has gone: stop playing.
    if (session.micOn) { session.micOn = false; this.app.command('mic', { on: false }); }
    if (this.guests.delete(session)) {
      this.store.activity('guest', `A guest stopped watching: ${session.label}`);
      if (!this.active && this.guests.size === 0) {
        this.captureOn = false;
        this.capture = null;
        this.app.command('capture', { on: false });
        this.app.command('session', { active: false });
      } else if (!this.active) {
        this._sendCapture(this.leader); // the next guest's link now sets the bitrate
      }
      this._changed();
      return;
    }
    if (this.active === session && this.guests.size > 0) {
      // The owner's viewer left but guests are still watching: keep the picture going for them, showing exactly
      // what the owner was showing (the same display, and only the one window if one was chosen), never more.
      this.active = null;
      for (const g of this.guests) {
        g.display = session.display;
        g.window = session.window ?? null;
      }
      this.app.command('session', { active: true, viewer: 'A guest (view only)', route: 'guest', curtain: false });
      this._sendCapture(this.leader);
      if (wasReady && reason !== 'signed-in-elsewhere') {
        this.store.activity('session', `${session.label} disconnected (${BYE_TEXT[reason] ?? reason})`);
      }
      this._changed();
      return;
    }
    if (this.active === session) {
      this.active = null;
      this.captureOn = false;
      this.capture = null;
      this.app.command('capture', { on: false });
      this.app.command('session', { active: false });
      // Leave the Mac locked behind the viewer, if the owner asked for that (not when Perch itself is quitting or
      // another of their devices is taking over).
      if (wasReady && this.store.settings.lockOnDisconnect && reason !== 'quit' && reason !== 'signed-in-elsewhere') {
        this.app.command('lock', {});
      }
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

  pairStart(site = null) {
    const info = this.auth.createPairing(typeof site === 'string' && site ? site : null);
    clearTimeout(this.pairTimer);
    this.pairTimer = setTimeout(() => this._changed(), PAIR_TTL_MS + 100);
    this.pairTimer.unref?.();
    this._changed();
    return info;
  }

  // --- guest link: show the screen to someone, view only ---

  async guestStart(minutes = 30, site = null) {
    const info = this.auth.createGuest({ minutes: Number(minutes), siteOrigin: typeof site === 'string' && site ? site : null });
    await this.signaling.setGuest(this.auth.guest);
    clearTimeout(this.guestTimer);
    // When the link runs out, everyone watching through it is disconnected.
    this.guestTimer = setTimeout(() => this.guestStop('expired').catch(() => {}), this.auth.guest.expiresAt - this.now() + 50);
    this.guestTimer.unref?.();
    this._changed();
    return info;
  }

  async guestStop(why = 'stopped') {
    clearTimeout(this.guestTimer);
    const had = !!this.auth.guest;
    this.auth.stopGuest();
    await this.signaling.setGuest(null);
    this._endSessions(s => s.route === 'guest', 'removed');
    if (had) this.store.activity('guest', why === 'expired' ? 'The guest link ran out' : 'Guest link stopped');
    this._changed();
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

  // --- sites this Mac accepts sign-ins from ---

  // Adds a site (the address of its Perch connect page). Only the Mac's owner can, in Setup on the Mac itself.
  siteAdd(address) {
    let u;
    try { u = new URL(String(address ?? '').trim()); } catch { throw new Error('That doesn’t look like a web address. It should start with https://'); }
    const local = this.config.test && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    if (u.protocol !== 'https:' && !local) throw new Error('The address must start with https://');
    if (u.username || u.password) throw new Error('The address can’t contain a username or password.');
    // Passkeys need a real domain name: not an IP address, and not a bare word.
    if (!local && !/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(u.hostname)) {
      throw new Error('The address needs a domain name, like example.com.');
    }
    if (this.auth.siteFor(u.origin)) throw new Error('That site is already on the list.');
    if (this.store.sites.length >= 8) throw new Error('That’s the most sites Perch keeps. Remove one first.');
    u.hash = '';
    u.search = '';
    if (u.pathname.endsWith('/')) u.pathname += 'connect.html';
    this.store.addSite({ origin: u.origin, url: u.href });
    this.store.activity('settings', `Sign-ins are now accepted from ${u.origin}`);
    this._changed();
    return { origin: u.origin, url: u.href };
  }

  // Removes a site, and with it the devices paired there (their passkeys only ever worked on that site).
  siteRemove(origin) {
    const site = this.auth.siteFor(origin);
    if (!site || site.builtIn) throw new Error('That site can’t be removed.');
    this.store.removeSite(origin);
    const stillServed = new Set(this.auth.sites().map(x => x.rpId));
    const gone = this.store.devices.filter(d => !stillServed.has(this.auth.deviceRpId(d)));
    for (const d of gone) {
      this.store.removeDevice(d.id);
      this._endSessions(x => x.deviceId === d.id, 'removed');
    }
    if (this.auth.pairing?.site === origin) this.auth.cancelPairing();
    this.store.activity('settings', `Sign-ins are no longer accepted from ${origin}` +
      (gone.length ? ` (${gone.length} device${gone.length === 1 ? '' : 's'} paired there removed)` : ''));
    this._changed();
    return { removedDevices: gone.length };
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

  // Offered to viewers: one-tap sign-in needs the Mac's fixed DTLS certificate.
  get caps() { return [...(this.store.dtlsKeys ? ['quick'] : []), 'fps60', 'view', 'window', 'mic', 'textfocus', 'clipboard', 'clipimg']; }

  async relaySet(keyId, apiToken) {
    const replacing = this.relay.configured;
    await this.relay.save(keyId, apiToken);
    this.store.activity('settings', replacing ? 'Relay key replaced' : 'Relay for strict networks set up');
    this._changed();
    return { ok: true };
  }

  async relayOwnerSet(key) {
    await this.relay.saveOwnerKey(key);
    this.store.activity('settings', 'This Mac is now one of the shared relay owner\u2019s Macs');
    this._changed();
    return { ok: true };
  }

  async relayOwnerRemove() {
    if (this.store.relayOwnerKey) this.store.activity('settings', 'Shared relay owner key removed');
    await this.relay.removeOwnerKey();
    this.relay.warm();
    this._changed();
  }

  async relayRemove() {
    if (this.relay.configured) this.store.activity('settings', 'Relay for strict networks removed');
    await this.relay.remove();
    this.relay.warm(); // the shared relay, if there is one, takes over
    this._changed();
  }

  // --- the Worker relay: the owner's own Cloudflare Worker, no payment details needed (wsrelay.mjs) ---

  // A Worker relay offer for this session (signaling.mjs puts it beside the WebRTC offer), or null without one.
  async relayOffer(session) {
    if (!this.workerRelay.configured) return null;
    session.ws = await this.workerRelay.prepare(session.sid, this.store.dtlsKeys);
    return session.ws?.offerText ?? null;
  }

  // The relay connection for a session whose viewer answered the Worker relay offer (session.answerRelay).
  async relayPeer(session, keys, answerText) {
    const { base, room, secret, offerText } = session.ws;
    return new WsPeer({
      url: roomUrl(base, room, 'mac', await roomAuth(secret, room)),
      offerText, answerText, keys, log: this.log.child(`relay ${session.sid.slice(0, 6)}`),
    });
  }

  // The Worker relay is also a rendezvous broker: viewers whose network blocks the public brokers find the Mac there.
  _useRelayBroker(previous = null) {
    if (previous) this.rendezvous.removeBroker?.(relayBroker(previous));
    if (this.workerRelay.base) this.rendezvous.addBroker?.(relayBroker(this.workerRelay.base));
  }

  async workerRelaySet(url) {
    const replacing = this.workerRelay.configured;
    const previous = this.workerRelay.base;
    await this.workerRelay.save(url);
    this._useRelayBroker(previous !== this.workerRelay.base ? previous : null);
    this.store.activity('settings', replacing ? 'Worker relay replaced' : 'Worker relay for strict networks set up');
    this._changed();
    return { ok: true };
  }

  async workerRelayRemove() {
    if (this.workerRelay.configured) this.store.activity('settings', 'Worker relay removed');
    const previous = this.workerRelay.base;
    await this.workerRelay.remove();
    this._useRelayBroker(previous);
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
        case 'loginItem': case 'keepAwake': case 'backupOn': case 'paused': case 'lockOnDisconnect': case 'curtain':
        case 'sharedRelay':
          if (typeof v !== 'boolean') throw new Error(`${k} must be true or false.`);
          break;
        case 'idleMinutes':
          // 0 is "Never" (Setup offers it). Tests may use a fraction of a minute so the idle timeout can be seen in
          // seconds.
          if (!(typeof v === 'number' && v <= 1440 && (v === 0 || (this.config.test ? v > 0 : Number.isInteger(v) && v >= 1)))) {
            throw new Error('The idle time must be a whole number of minutes from 1 to 1440, or never.');
          }
          break;
        case 'quality':
          if (typeof v !== 'string' || !Object.hasOwn(QUALITY, v)) throw new Error(`Quality must be one of ${Object.keys(QUALITY).join(', ')}.`);
          break;
        case 'micOutput':
          // '' is the Mac's own current output; otherwise one of the outputs the app listed.
          if (typeof v !== 'string' || (v !== '' && !this.audioOutputs.some(d => d.uid === v))) throw new Error('Choose one of this Mac\'s sound outputs.');
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
    // The curtain can go up or down in the middle of a session.
    if ('curtain' in patch && this.active) {
      this.app.command('session', { active: true, viewer: this.active.label, route: this.active.route, curtain: after.curtain });
    }
    if ('loginItem' in patch) this.app.command('login-item', { on: after.loginItem });
    if ('sharedRelay' in patch && after.sharedRelay !== before.sharedRelay) {
      this.relay.forget();
      this.relay.warm();
      this.store.activity('settings', after.sharedRelay ? 'Shared relay turned on' : 'Shared relay turned off');
    }
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
    return this._rename(makeMacName());
  }

  // A name the owner chose (Setup marks this "not recommended": a made-up name is far harder to guess, and the name is
  // the username for backup sign-in and its meeting point). Same effect as newMacName otherwise.
  async customMacName(name) {
    const clean = normalizeMacName(name);
    if (!CUSTOM_MAC_NAME_RE.test(clean)) {
      throw new Error('Use 4 to 40 letters or numbers, with single hyphens between words, like jordan-macbook.');
    }
    if (clean === this.store.macName) throw new Error('That is already this Mac’s name.');
    return this._rename(clean);
  }

  async _rename(name) {
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
    const relayBefore = this.workerRelay.base;
    this._endSessions(() => true, 'removed');
    this.auth.cancelPairing();
    await this.guestStop();
    this.auth.pendingTotp = null;
    await this.store.reset();
    await this.auth.init();
    // The new identity needs its own connection certificate straight away: without one, new passkeys would carry no
    // pin and one-tap sign-in would stay off until Perch was next restarted.
    await ensureDtlsIdentity(this.store);
    this.relay.forget();
    this.workerRelay.lastError = this.workerRelay.lastOkAt = null; // Start over removed its secret with the rest
    this._useRelayBroker(relayBefore);
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
    clearTimeout(this.guestTimer);
    await this.signaling.close().catch(() => {});
  }
}

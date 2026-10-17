// One viewer's connection, from the WebRTC offer to the end. See docs/PROTOCOL.md, "Control channel: signing in"
// and "Control channel: during a session".
//
// A session starts unauthenticated and stays that way until every check for its route has passed over this exact
// connection's binding value. Until then nothing is sent but sign-in messages: no picture, no sound, and input is
// ignored. The controller ("hub") owns the app and decides which signed-in session is the active one.
import { randomBytes } from 'node:crypto';
import { bindingHash, bindProof } from '../../../site/js/shared/bind.js';
import { toB64url, fromB64url, equalBytes } from '../../../site/js/shared/bytes.js';
import { PROTO, AUTH_TIMEOUT_MS, QUALITY } from '../../../site/js/shared/proto.js';
import { AuthError } from './auth.mjs';
import { MediaSender } from './media.mjs';
import { validateInput, RateLimiter, POINTER_RATE, INPUT_RATE, CONTROL_RATE } from './input.mjs';

export const MAX_CONTROL_BYTES = 64 * 1024;
export const MAX_INPUT_BYTES = 4096;
export const STATUS_EVERY_MS = 2000;
export const MAX_CODE_TRIES = 3;
export const BYE_REASONS = ['signed-in-elsewhere', 'paused', 'quit', 'idle', 'removed', 'disconnected'];
const ROUTE_TEXT = { passkey: 'passkey', backup: 'backup password', pair: 'pairing' };
const FIRST_STEP = { passkey: 'assert', backup: 'opaque1', pair: 'pair1' };
const CLOSE_DELAY_MS = 250;

const seconds = ms => Math.max(1, Math.ceil(ms / 1000));
const cleanLabel = s => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : '');

export class Session {
  constructor({ sid, route, label, peer, auth, store, hub, log, now = () => Date.now(), authTimeoutMs = AUTH_TIMEOUT_MS }) {
    Object.assign(this, { sid, route, label, peer, auth, store, hub, log, now });
    this.state = 'new';        // new → offered → connecting → auth → ready → ended
    this.step = null;          // within 'auth': assert | opaque1 | opaque3 | pair1 | pair-cred | code
    this.createdAt = now();
    this.signedInAt = null;
    this.deviceId = null;
    this.bind = null;
    this.media = null;
    this.quality = null;
    this.display = null;
    this.codeTries = 0;
    this.holdsPairing = false;
    this.backupAttempt = null;  // the backup attempt counted at opaque1, taken back once the password is proven
    this.lastInputAt = 0;
    this.lastSample = null;     // the last status period's measured send rate and frame rate
    this.endReason = null;
    this.chain = Promise.resolve();
    this.controlRate = new RateLimiter(CONTROL_RATE);
    this.inputRate = new RateLimiter(INPUT_RATE);
    this.pointerRate = new RateLimiter(POINTER_RATE);
    this.stats = { inputDroppedBeforeSignIn: 0, inputForwarded: 0, inputRejected: 0 };
    this.timers = new Set();
    this.subs = [];

    this._timer(() => {
      if (this.state !== 'ready' && this.state !== 'ended') {
        this.log?.info(`sign-in timed out (${this.route})`);
        this._deny('timeout');
      }
    }, authTimeoutMs);

    const { control, input, pointer } = peer.channels;
    this.subs.push(control.stateChanged.subscribe(s => {
      if (s === 'open') this._onControlOpen().catch(e => { this.log?.error('hi failed:', e); this.end('error'); });
      else if (s === 'closed') this.end('disconnected', { sendBye: false });
    }));
    this.subs.push(control.onMessage.subscribe(d => this._onControl(d)));
    this.subs.push(input.onMessage.subscribe(d => this._onInput(d, 'input')));
    this.subs.push(pointer.onMessage.subscribe(d => this._onInput(d, 'pointer')));
    const unwatch = peer.onConnectionState(s => {
      if (s === 'failed' || s === 'closed') this.end('disconnected', { sendBye: false });
    });
    this.subs.push({ unSubscribe: unwatch });
  }

  get signedIn() { return this.state === 'ready'; }

  _timer(fn, ms, repeat = false) {
    const id = repeat ? setInterval(fn, ms) : setTimeout(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
    return id;
  }

  _send(obj) {
    const ch = this.peer.channels.control;
    if (ch.readyState !== 'open') return false;
    try { ch.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  // --- WebRTC setup (driven by src/signaling.mjs) ---

  async offer() {
    if (this.state !== 'new') throw new Error('offer already made');
    const sdp = await this.peer.createOffer();
    if (this.state === 'new') this.state = 'offered';
    return sdp;
  }

  async answer(sdp) {
    if (this.state !== 'offered') return;
    this.state = 'connecting';
    await this.peer.acceptAnswer(sdp);
  }

  async _onControlOpen() {
    if (this.state !== 'connecting') return;
    const nonce = randomBytes(32);
    this.bind = await bindingHash(new Uint8Array(nonce), this.peer.offerSdp, this.peer.answerSdp);
    if (this.state !== 'connecting') return;
    this.state = 'auth';
    this.step = FIRST_STEP[this.route];
    this._send({ t: 'hi', pv: PROTO, hv: this.hub.hv, nonce: toB64url(nonce), name: this.store.macName, route: this.route });
  }

  // --- control channel ---

  _onControl(data) {
    if (this.state === 'ended') return;
    if (typeof data !== 'string' || data.length > MAX_CONTROL_BYTES) return this._protocol('control message too big or not text');
    if (!this.controlRate.take()) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return this._protocol('control message is not JSON'); }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this._protocol('control message has no type');
    // Handlers wait on crypto; run them one at a time, in order.
    this.chain = this.chain.then(() => this._handle(msg)).catch(e => {
      this.log?.error('control handler failed:', e);
      this._deny('error');
    });
  }

  _protocol(why) {
    this.log?.info(`protocol error: ${why}`);
    if (this.state === 'ready') return; // a signed-in viewer sending junk is dropped, not cut off
    this._deny('protocol');
  }

  async _handle(msg) {
    if (this.state === 'ended') return;
    if (msg.t === 'bye') return this.end('bye', { sendBye: false });
    if (this.state === 'ready') return this._handleReady(msg);
    if (this.state !== 'auth') return this._protocol(`${msg.t} before hi`);
    const expect = { assert: 'assert', opaque1: 'opaque1', opaque3: 'opaque3', pair1: 'pair1', 'pair-cred': 'pair-cred', code: 'code' }[this.step];
    if (msg.t !== expect && !(this.step === 'opaque3' && msg.t === 'opaque-fail')) return this._protocol(`${msg.t} during ${this.step}`);
    const locked = this.auth.lockedFor(this.route);
    if (locked > 0 && this.step !== 'opaque3' && this.step !== 'pair-cred') {
      return this._deny('locked-out', { retryAfter: seconds(locked) });
    }
    switch (this.step) {
      case 'assert': return this._assert(msg);
      case 'opaque1': return this._opaque1(msg);
      case 'opaque3': return this._opaque3(msg);
      case 'pair1': return this._pair1(msg);
      case 'pair-cred': return this._pairCred(msg);
      case 'code': return this._code(msg);
    }
  }

  // A failed check: count it towards the route's lockout and tell the viewer.
  _failed(e, what) {
    this.log?.info(`${this.route} sign-in refused: ${e.message}`);
    const lockedMs = this.auth.fail(this.route, what);
    if (lockedMs > 0) return this._deny('locked-out', { retryAfter: seconds(lockedMs) });
    return this._deny(e.reason);
  }

  async _assert(msg) {
    try {
      const device = await this.auth.verifyAssertion(msg.response, this.bind);
      this.deviceId = device.id;
      this.deviceLabel = device.label;
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      return this._failed(e, `Passkey sign-in refused (${this.label})`);
    }
    this._askCode();
  }

  async _opaque1(msg) {
    // Count the attempt now: the viewer finds out on its own whether the password was right, so it might never
    // tell us. If this attempt is the one that locks the route it still goes ahead (it is the last one allowed);
    // the next one is refused. A proven password takes the count back (see _opaque3).
    const attempt = this.auth.attempt('backup');
    const start = this.auth.opaqueLoginStart(msg.req);
    if (!start) {
      this.auth.note('failure', `Backup sign-in refused: malformed request (${this.label})`);
      return attempt.lockedMs ? this._deny('locked-out', { retryAfter: seconds(attempt.lockedMs) }) : this._deny('wrong-password');
    }
    this.backupAttempt = attempt;
    this.serverLoginState = start.serverLoginState;
    this.step = 'opaque3';
    this._send({ t: 'opaque2', res: start.loginResponse });
  }

  async _opaque3(msg) {
    const state = this.serverLoginState;
    this.serverLoginState = null;
    if (msg.t === 'opaque-fail') {
      this.auth.note('failure', `Wrong backup password (${this.label})`);
      return this._deny('wrong-password');
    }
    const key = this.auth.opaqueLoginFinish(state, msg.fin);
    if (!key) {
      this.auth.note('failure', `Wrong backup password (${this.label})`);
      return this._deny('wrong-password');
    }
    let given = null;
    try { given = typeof msg.proof === 'string' && msg.proof.length <= 64 ? fromB64url(msg.proof) : null; } catch {}
    if (!given || !equalBytes(given, await bindProof(key, 'backup', this.bind))) {
      // The password was right but the proof wasn't made over this connection: something changed the SDP on the way.
      this.auth.note('failure', `Backup sign-in proof did not match this connection (${this.label})`);
      return this._deny('bad-proof');
    }
    // The password is proven: this was not a failed attempt after all. The code still has to be right.
    this.backupAttempt?.undo();
    this.backupAttempt = null;
    this._askCode();
  }

  async _pair1(msg) {
    try {
      await this.auth.checkPairProof(msg.pairId, msg.proof, this.bind, this);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      this.log?.info(`pairing refused: ${e.message}`);
      this.auth.note('failure', `Pairing refused: ${e.reason} (${this.label})`);
      return this._deny(e.reason);
    }
    this.holdsPairing = true;
    this.step = 'pair-cred';
    this._send({ t: 'pair-options', options: this.auth.creationOptions(this.bind) });
  }

  async _pairCred(msg) {
    try {
      this.newDevice = await this.auth.verifyRegistration(msg.response, this.bind);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      this.log?.info(`pairing refused: ${e.message}`);
      this.auth.note('failure', `Pairing refused: new passkey not accepted (${this.label})`);
      return this._deny(e.reason);
    }
    this.newDeviceLabel = cleanLabel(msg.label) || this.label;
    this._askCode();
  }

  _askCode() {
    this.step = 'code';
    this._send({ t: 'totp' });
  }

  async _code(msg) {
    const code = typeof msg.code === 'string' ? msg.code.replace(/\s/g, '') : '';
    if (!this.auth.checkTotp(code)) {
      this.codeTries++;
      const lockedMs = this.auth.fail(this.route, `Wrong authenticator code (${ROUTE_TEXT[this.route]} sign-in, ${this.label})`);
      if (lockedMs > 0) return this._deny('locked-out', { retryAfter: seconds(lockedMs) });
      if (this.codeTries >= MAX_CODE_TRIES) return this._deny('wrong-code');
      this._send({ t: 'denied', reason: 'wrong-code', final: false });
      return;
    }
    this.auth.succeed(this.route);
    if (this.route === 'pair') {
      // The owner may have cancelled the link while this viewer was typing the code.
      if (this.auth.pairing?.holder !== this) return this._deny('link-expired');
      const dev = { ...this.newDevice, label: this.newDeviceLabel, lastUsedAt: new Date(this.now()).toISOString() };
      this.store.addDevice(dev);
      this.auth.consumePairing(this);
      this.holdsPairing = false;
      this.deviceId = dev.id;
      this.deviceLabel = dev.label;
      this.store.activity('pairing', `New device paired: ${dev.label}`);
      this._send({ t: 'paired', name: this.store.macName, credentialId: dev.id });
    } else if (this.deviceId) {
      this.store.updateDevice(this.deviceId, { lastUsedAt: new Date(this.now()).toISOString() });
    }
    this._signedIn();
  }

  _signedIn() {
    this.state = 'ready';
    this.step = null;
    this.signedInAt = this.now();
    this.lastInputAt = this.now();
    const how = this.route === 'backup' ? 'the backup password' : this.route === 'pair' ? 'a new passkey' : 'a passkey';
    const who = this.deviceLabel && this.deviceLabel !== this.label ? `${this.label} (${this.deviceLabel})` : this.label;
    this.store.activity('sign-in', `Signed in with ${how}: ${who}`);
    this.log?.info(`signed in (${this.route})`);
    const info = this.hub.sessionSignedIn(this);
    this.quality = info.quality;
    this.display = info.display.id;
    this.media = new MediaSender({
      video: this.peer.videoSender,
      audio: this.peer.audioSender,
      quality: this.quality,
      log: this.log,
      onKeyframe: () => this.hub.keyframe(this),
      onBitrate: kbps => this.hub.bitrate(this, kbps),
    });
    this._send({ t: 'ready', name: this.store.macName, hv: this.hub.hv, ...info });
    this.media.start();
    // Rates are measured over each status period. A status sent early because something changed (capture started,
    // a permission, the lock) repeats the last measurement: measuring over a few milliseconds would show nonsense.
    this._timer(() => { this.lastSample = this.media.sample(); this.sendStatus(); }, STATUS_EVERY_MS, true);
    this._watchIdle();
    if (!this.hub.permissions.screen) this.sendError('no-screen-permission', 'The Mac has not allowed Perch to record the screen yet.');
  }

  _watchIdle() {
    const idleMs = () => this.store.settings.idleMinutes * 60000;
    const check = () => {
      if (this.state !== 'ready') return;
      if (this.now() - this.lastInputAt >= idleMs()) this.end('idle');
    };
    this._timer(check, Math.max(50, Math.min(30000, idleMs() / 4)), true);
  }

  // --- during a session ---

  _handleReady(msg) {
    switch (msg.t) {
      case 'ping':
        if (Number.isFinite(msg.n) && Number.isFinite(msg.ts)) this._send({ t: 'pong', n: msg.n, ts: msg.ts });
        return;
      case 'quality':
        if (typeof msg.preset !== 'string' || !Object.hasOwn(QUALITY, msg.preset) || msg.preset === this.quality) return;
        this.quality = msg.preset;
        this.media.setQuality(msg.preset);
        this.hub.captureChanged(this);
        return;
      case 'display':
        if (!this.hub.hasDisplay(msg.id) || msg.id === this.display) return;
        this.display = msg.id;
        this.hub.captureChanged(this);
        return;
      case 'keyframe':
        this.media.askKeyframe('viewer asked');
        return;
      default:
        return; // newer viewers may send things this host doesn't know; ignore them
    }
  }

  _onInput(data, channel) {
    if (this.state !== 'ready') {
      this.stats.inputDroppedBeforeSignIn++;
      return;
    }
    if (typeof data !== 'string' || data.length > MAX_INPUT_BYTES) { this.stats.inputRejected++; return; }
    if (!(channel === 'pointer' ? this.pointerRate : this.inputRate).take()) { this.stats.inputRejected++; return; }
    let msg;
    try { msg = JSON.parse(data); } catch { this.stats.inputRejected++; return; }
    const clean = validateInput(msg, channel);
    if (!clean) { this.stats.inputRejected++; return; }
    this.lastInputAt = this.now();
    if (this.hub.input(this, clean)) this.stats.inputForwarded++;
  }

  sendStatus() {
    if (this.state !== 'ready') return;
    const s = this.lastSample ?? { kbps: 0, fps: 0 };
    const cap = this.hub.capture ?? {};
    this._send({
      t: 'status', locked: !!this.hub.locked, link: this.media.bitrate.link, kbps: s.kbps, fps: s.fps,
      width: cap.width ?? 0, height: cap.height ?? 0, input: !!this.hub.permissions.accessibility,
    });
  }

  sendError(code, message) {
    if (this.state === 'ready') this._send({ t: 'error', code, message });
  }

  pushVideo(frame) { if (this.state === 'ready') this.media.pushVideo(frame); }
  pushAudio(frame) { if (this.state === 'ready') this.media.pushAudio(frame); }

  // --- ending ---

  _deny(reason, extra = {}) {
    if (this.state === 'ended') return;
    this._send({ t: 'denied', reason, ...extra, final: true });
    this.end('denied', { sendBye: false });
  }

  end(reason, { sendBye = true } = {}) {
    if (this.state === 'ended') return;
    const wasReady = this.state === 'ready';
    this.state = 'ended';
    this.endReason = reason;
    for (const id of this.timers) { clearTimeout(id); clearInterval(id); }
    this.timers.clear();
    this.media?.stop();
    if (this.holdsPairing) this.auth.releasePairing(this);
    this.holdsPairing = false;
    if (sendBye && BYE_REASONS.includes(reason)) this._send({ t: 'bye', reason });
    for (const s of this.subs) s.unSubscribe?.();
    this.subs = [];
    if (wasReady) this.log?.info(`session ended (${reason})`);
    // A moment's grace so the last message (bye or denied) actually leaves before the connection closes.
    const closeTimer = setTimeout(() => this.peer.close(), CLOSE_DELAY_MS);
    closeTimer.unref?.();
    this.hub.sessionEnded(this, reason, wasReady);
  }
}

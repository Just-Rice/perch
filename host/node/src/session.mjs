// One viewer's connection, from the WebRTC offer to the end. See docs/PROTOCOL.md, "Control channel: signing in"
// and "Control channel: during a session".
//
// A session starts unauthenticated and stays that way until every check for its route has passed over this exact
// connection's binding value. Until then nothing is sent but sign-in messages: no picture, no sound, and input is
// ignored. The controller ("hub") owns the app and decides which signed-in session is the active one.
import { randomBytes } from 'node:crypto';
import { bindingHash, bindProof, quickChallenge, sdpFingerprint } from '../../../site/js/shared/bind.js';
import { toB64url, fromB64url, equalBytes } from '../../../site/js/shared/bytes.js';
import { PROTO, AUTH_TIMEOUT_MS, QUALITY } from '../../../site/js/shared/proto.js';
import { AuthError } from './auth.mjs';
import { MediaSender, ResolutionGovernor, ladderAtLeast } from './media.mjs';
import { readAnswer, sessionKeys } from '../../../site/js/shared/wsrelay.js';
import { validateInput, RateLimiter, POINTER_RATE, INPUT_RATE, CONTROL_RATE } from './input.mjs';

const ANSWER_TIMEOUT_MS = 15000; // offer sent, no answer yet

export const MAX_CONTROL_BYTES = 64 * 1024;
export const MAX_INPUT_BYTES = 4096;
export const MAX_CLIP_CHARS = 30000; // clipboard text, either way (the Mac app has the same limit)
// Clipboard images go in pieces of CLIP_PART_CHARS base64 characters, each in its own control message, followed by the
// clip-set or clip that names them. At most MAX_CLIP_IMAGE bytes (the Mac app has the same limit).
export const MAX_CLIP_IMAGE = 20 * 1024 * 1024;
export const CLIP_PART_CHARS = 48 * 1024;
const MAX_CLIP_B64 = Math.ceil(MAX_CLIP_IMAGE / 3) * 4;
const CLIP_PART_RATE = { rate: 400, burst: 600 }; // pieces of an image only; everything else has CONTROL_RATE
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
export const STATUS_EVERY_MS = 2000;
export const MAX_CODE_TRIES = 3;
export const BYE_REASONS = ['signed-in-elsewhere', 'paused', 'quit', 'idle', 'removed', 'disconnected'];
const ROUTE_TEXT = { passkey: 'passkey', backup: 'backup password', pair: 'pairing', guest: 'guest link' };
const FIRST_STEP = { passkey: 'assert', backup: 'opaque1', pair: 'pair1', guest: 'guest1' };
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
    this.viewEdge = null;       // the longest edge of the picture on the viewer's screen, in its pixels (if it said)
    this.governor = new ResolutionGovernor();
    this.lastSample = null;     // the last status period's measured send rate and frame rate
    this.endReason = null;
    this.chain = Promise.resolve();
    this.controlRate = new RateLimiter(CONTROL_RATE);
    this.clipPartRate = new RateLimiter(CLIP_PART_RATE);
    this.inputRate = new RateLimiter(INPUT_RATE);
    this.pointerRate = new RateLimiter(POINTER_RATE);
    this.micRate = new RateLimiter({ rate: 120, burst: 120 });
    this.stats = { inputDroppedBeforeSignIn: 0, inputForwarded: 0, inputRejected: 0 };
    this.timers = new Set();
    this.subs = [];

    this._timer(() => {
      if (this.state !== 'ready' && this.state !== 'ended') {
        this.log?.info(`sign-in timed out (${this.route})`);
        this._deny('timeout');
      }
    }, authTimeoutMs);
    // A real browser answers within a few seconds; one that never does is only holding a sign-in slot.
    this._timer(() => {
      if (this.state === 'new' || this.state === 'offered') {
        this.log?.info(`no answer from the viewer (${this.route})`);
        this.end('timeout', { sendBye: false });
      }
    }, Math.min(authTimeoutMs, ANSWER_TIMEOUT_MS));

    this.transport = 'webrtc';
    this.ws = null;            // the Worker relay offer made alongside the WebRTC one, if the Mac has a relay
    this.peerSubs = [];
    this._attach(peer);
  }

  // Listens to a peer's channels and state: the WebRTC peer, or the relay peer (wsrelay.mjs) that replaces it when
  // the viewer answers over the Worker relay. Both have the same three channels.
  _attach(peer) {
    const { control, input, pointer } = peer.channels;
    const subs = this.peerSubs = [];
    subs.push(control.stateChanged.subscribe(s => {
      if (s === 'open') this._onControlOpen().catch(e => { this.log?.error('hi failed:', e); this.end('error'); });
      else if (s === 'closed') this.end('disconnected', { sendBye: false });
    }));
    subs.push(control.onMessage.subscribe(d => this._onControl(d)));
    subs.push(input.onMessage.subscribe(d => this._onInput(d, 'input')));
    subs.push(pointer.onMessage.subscribe(d => this._onInput(d, 'pointer')));
    peer.onMicRtp = rtp => this._onMic(rtp);
    const unwatch = peer.onConnectionState(s => {
      if (s === 'failed' || s === 'closed') this.end('disconnected', { sendBye: false });
    });
    subs.push({ unSubscribe: unwatch });
  }

  _detach() {
    for (const s of this.peerSubs) s.unSubscribe?.();
    this.peerSubs = [];
    this.peer.onMicRtp = null;
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

  // The viewer answered over the Worker relay instead (its network blocks WebRTC). The WebRTC peer is closed and a
  // relay peer takes its place; from here on everything (hi, binding, sign-in, media) is the same, over the relay.
  // `makePeer(keys, answerText)` builds the relay peer (the hub knows the relay's address and secret).
  async answerRelay(text, makePeer) {
    if (this.state !== 'offered' || !this.ws) return;
    this.state = 'connecting';
    const { eph } = readAnswer(text, { sid: this.sid });
    const keys = await sessionKeys(this.ws.privateKey, eph, this.ws.offerText, text, 'mac');
    if (this.state !== 'connecting') return;
    const webrtc = this.peer;
    this._detach();
    webrtc.close();
    this.peer = await makePeer(keys, text);
    this.transport = 'relay';
    if (this.state !== 'connecting') { this.peer.close(); return; }
    this._attach(this.peer);
    this.peer.connect();
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
    // Pieces of a clipboard image come many at once; they have their own allowance, for a signed-in viewer only.
    const part = this.state === 'ready' && data.startsWith('{"t":"clip-part"');
    if (!(part ? this.clipPartRate : this.controlRate).take()) return;
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
    const expect = { assert: 'assert', opaque1: 'opaque1', opaque3: 'opaque3', pair1: 'pair1', 'pair-cred': 'pair-cred', code: 'code',
      guest1: 'guest1' }[this.step];
    if (msg.t !== expect && !(this.step === 'opaque3' && msg.t === 'opaque-fail')) return this._protocol(`${msg.t} during ${this.step}`);
    if (this.step === 'guest1') return this._guest1(msg);
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


  async _assert(msg) {
    try {
      // One-tap sign-in: the passkey signed the browser's own certificate fingerprint before connecting (bind.js,
      // "quick"). Otherwise it signed this connection's binding, as usual.
      const challenge = msg.quick !== undefined ? await this._quickChallenge(msg.quick) : this.bind;
      const device = await this.auth.verifyAssertion(msg.response, challenge);
      this.deviceId = device.id;
      this.deviceLabel = device.label;
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      // Refused without counting toward the lockout. A passkey signature can't be guessed, so the lockout is only for
      // the 6-digit code; counting passkey failures would let anyone holding the rendezvous key (an old pairing link,
      // a removed device) keep the owner locked out just by sending rubbish.
      this.log?.info(`passkey sign-in refused: ${e.message}`);
      return this._deny(e.reason);
    }
    this._askCode();
  }

  // The challenge a one-tap sign-in must have signed: over the certificate this viewer's DTLS actually used (the one
  // in the answer it sent, which werift holds it to), a fresh time and a never-seen r. Throws AuthError otherwise.
  async _quickChallenge(q) {
    const fingerprint = sdpFingerprint(this.peer.answerSdp);
    if (!fingerprint) throw new AuthError('bad-proof', 'one-tap sign-in: the answer has no single sha-256 fingerprint');
    let r = null;
    try { r = q && typeof q.r === 'string' ? fromB64url(q.r) : null; } catch {}
    if (!r || r.length !== 16 || !Number.isSafeInteger(q.ts)) throw new AuthError('bad-proof', 'one-tap sign-in: malformed');
    this.auth.useQuickNonce(q.r, q.ts); // throws if stale or seen before
    return quickChallenge(r, q.ts, fingerprint);
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

  // A guest: the link itself is the pass (the owner handed it out on purpose). It only ever lets them watch.
  async _guest1(msg) {
    try {
      await this.auth.checkGuestProof(msg.proof, this.bind);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      this.log?.info(`guest refused: ${e.message}`);
      return this._deny(e.reason);
    }
    this.guest = true;
    this._signedIn();
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
    let options;
    try {
      options = this.auth.creationOptions(this.bind, typeof msg.origin === 'string' ? msg.origin : null);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      this.auth.releasePairing(this);
      this.log?.info(`pairing refused: ${e.message}`);
      return this._deny(e.reason);
    }
    this.holdsPairing = true;
    this.step = 'pair-cred';
    this._send({ t: 'pair-options', options });
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
      // The owner may have cancelled the link (or it ran out) while this viewer was typing the code.
      if (!this.auth.pairingInfo() || this.auth.pairing?.holder !== this) return this._deny('link-expired');
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
    this.store.activity(this.guest ? 'guest' : 'sign-in', this.guest ? `A guest started watching: ${this.label}` : `Signed in with ${how}: ${who}`);
    this.log?.info(`signed in (${this.route})`);
    const info = this.guest ? this.hub.guestSignedIn(this) : this.hub.sessionSignedIn(this);
    this.quality = info.quality;
    this.governor.setFps((QUALITY[this.quality] ?? QUALITY.balanced).fps);
    this.display = info.display.id;
    const mediaOptions = {
      quality: this.quality,
      log: this.log,
      onKeyframe: () => this.hub.keyframe(this),
      onBitrate: kbps => this.hub.bitrate(this, kbps),
    };
    // Over the Worker relay, whole frames go over the WebSocket instead of RTP (wsrelay.mjs).
    this.media = this.peer.createMediaSender ? this.peer.createMediaSender(mediaOptions)
      : new MediaSender({ video: this.peer.videoSender, audio: this.peer.audioSender, ...mediaOptions });
    this._send({ t: 'ready', name: this.store.macName, hv: this.hub.hv, ...info });
    this.media.start();
    // Rates are measured over each status period. A status sent early because something changed (capture started,
    // a permission, the lock) repeats the last measurement: measuring over a few milliseconds would show nonsense.
    this._timer(() => {
      this.lastSample = this.media.sample();
      // A link that can't carry this picture size at full frame rate gets a smaller picture (and the size comes back
      // when the link does).
      if (!this.guest && this.governor.update(this.media.bitrate.target, this.wantedEdge()) !== undefined) this.hub.captureChanged(this);
      this.sendStatus();
    }, STATUS_EVERY_MS, true);
    if (!this.guest) this._watchIdle(); // a guest never sends input; the link's own time limit ends their watching
    if (!this.hub.permissions.screen) this.sendError('no-screen-permission', 'The Mac has not allowed Perch to record the screen yet.');
  }

  // The largest picture worth sending: what the quality preset allows, and no more than the viewer's screen shows.
  wantedEdge() {
    const preset = QUALITY[this.quality] ?? QUALITY.balanced;
    return this.viewEdge ? Math.min(preset.maxEdge, ladderAtLeast(this.viewEdge)) : preset.maxEdge;
  }

  // What to capture at right now: wantedEdge, less if the link can't carry it.
  captureEdge() {
    return Math.min(this.wantedEdge(), this.governor.cap ?? Infinity);
  }

  _watchIdle() {
    // idleMinutes 0 is "Never": the session stays however long nothing is typed or clicked. The setting can change
    // during a session, so the limit is read at every check (and a session that started on "Never" checks twice a
    // minute, in case it's changed).
    const idleMs = () => this.store.settings.idleMinutes * 60000;
    const check = () => {
      if (this.state !== 'ready') return;
      const limit = idleMs();
      if (limit > 0 && this.now() - this.lastInputAt >= limit) this.end('idle');
    };
    this._timer(check, Math.max(50, Math.min(30000, (idleMs() || 120000) / 4)), true);
  }

  // --- during a session ---

  _handleReady(msg) {
    // A guest may only keep the connection alive and ask for a fresh picture; everything else is the owner's.
    if (this.guest && msg.t !== 'ping' && msg.t !== 'keyframe') return;
    switch (msg.t) {
      case 'ping':
        if (Number.isFinite(msg.n) && Number.isFinite(msg.ts)) this._send({ t: 'pong', n: msg.n, ts: msg.ts });
        return;
      case 'quality':
        if (typeof msg.preset !== 'string' || !Object.hasOwn(QUALITY, msg.preset) || msg.preset === this.quality) return;
        this.quality = msg.preset;
        this.media.setQuality(msg.preset);
        this.governor.reset();
        this.governor.setFps(QUALITY[msg.preset].fps);
        this.hub.captureChanged(this);
        return;
      case 'view': {
        // How big the picture is on the viewer's screen: no point sending more pixels than that.
        if (!Number.isFinite(msg.edge)) return;
        const before = this.captureEdge();
        this.viewEdge = Math.min(8192, Math.max(320, Math.round(msg.edge)));
        if (this.captureEdge() !== before) this.hub.captureChanged(this);
        return;
      }
      case 'display':
        if (!this.hub.hasDisplay(msg.id) || msg.id === this.display) return;
        this.display = msg.id;
        this.window = null; // a window chosen on the other display doesn't carry over
        this.hub.captureChanged(this);
        return;
      case 'windows': {
        // Which windows could be shown on their own. The answer comes back as {t:'windows', list}.
        const now = this.now();
        if (now - (this.windowsAskedAt ?? -Infinity) < 300) return;
        this.windowsAskedAt = now;
        this.hub.listWindows(this);
        return;
      }
      case 'window': {
        // Show one window (the picture follows it), or null for the whole display again.
        const id = msg.id === null ? null : (Number.isInteger(msg.id) && msg.id > 0 && msg.id <= 0xffffffff ? msg.id : undefined);
        if (id === undefined || id === (this.window ?? null)) return;
        this.window = id;
        this.hub.captureChanged(this);
        return;
      }
      case 'clip-get': {
        // The Mac's clipboard text, for the viewer to copy. Answered with {t:'clip', ok, text}.
        const now = this.now();
        if (now - (this.clipAt ?? -Infinity) < 300) return;
        this.clipAt = now;
        this.hub.clipGet(this, msg.images === true);
        return;
      }
      case 'clip-part':
        return this._clipPart(msg);
      case 'clip-set': {
        // Text and/or an image (sent before in clip-part pieces) from the viewer onto the Mac's clipboard, and pasted
        // there if asked. Answered with {t:'clip-set', ok}.
        const text = msg.text === undefined ? undefined : msg.text;
        let image;
        if (msg.img !== undefined) {
          const c = this.clipIn;
          this.clipIn = null;
          if (!c || !msg.img || msg.img.id !== c.id || c.got !== c.n) return this._send({ t: 'clip-set', ok: false });
          image = c.parts.join('');
        }
        if ((text !== undefined && (typeof text !== 'string' || text.length > MAX_CLIP_CHARS)) || (text === undefined && !image)) {
          return this._send({ t: 'clip-set', ok: false });
        }
        this.hub.clipSet(this, text, msg.paste === true, image);
        return;
      }
      case 'clip-sync':
        // The viewer wants whatever is copied on the Mac from now on, as {t:'clip', auto: true, ...}.
        this.clipSync = msg.on === true;
        return;
      case 'mic':
        // The viewer turned their microphone on or off: the Mac plays what they say.
        if (typeof msg.on !== 'boolean' || msg.on === !!this.micOn) return;
        this.micOn = msg.on;
        this.hub.micChanged(this, msg.on);
        return;
      case 'fit':
        // Reshape the window being shown to this viewer's screen (w by h, any unit: only the shape matters).
        if (this.window == null || !(msg.w >= 1 && msg.w <= 20000) || !(msg.h >= 1 && msg.h <= 20000)) return;
        this.hub.fitWindow(this, msg.w, msg.h);
        return;
      case 'keyframe':
        this.media.askKeyframe('viewer asked');
        return;
      default:
        return; // newer viewers may send things this host doesn't know; ignore them
    }
  }

  // The viewer's microphone, one Opus packet at a time. Only from the signed-in owner, only while they have it on,
  // and never more than a voice needs (50 packets a second is normal).
  _onMic(rtp) {
    if (this.state !== 'ready' || this.guest || !this.micOn) return;
    const payload = rtp?.payload;
    if (!payload || payload.length === 0 || payload.length > 1500 || !this.micRate.take()) { this.stats.micDropped = (this.stats.micDropped ?? 0) + 1; return; }
    this.hub.mic(this, rtp.header.sequenceNumber, payload);
  }

  _onInput(data, channel) {
    if (this.guest) return; // view only, always
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

  // `extra`: fields sent only when they change (the list of displays and which one is shown).
  sendStatus(extra = {}) {
    if (this.state !== 'ready') return;
    const s = this.lastSample ?? { kbps: 0, fps: 0 };
    const cap = this.hub.capture ?? {};
    this._send({
      t: 'status', locked: !!this.hub.locked, link: this.media.bitrate.link, kbps: s.kbps, fps: s.fps,
      width: cap.width ?? 0, height: cap.height ?? 0, input: !this.guest && !!this.hub.permissions.accessibility,
      window: cap.window ?? null, ...extra,
    });
  }

  sendWindows(list) { if (this.state === 'ready' && !this.guest) this._send({ t: 'windows', list }); }
  // The Mac's clipboard: text, and a PNG (base64) sent ahead in clip-part pieces. auto: copied on the Mac just now.
  sendClip(text, ok = true, { image = null, auto = false } = {}) {
    if (this.state !== 'ready' || this.guest) return;
    const m = { t: 'clip', ok: !!ok, text: ok ? String(text ?? '').slice(0, MAX_CLIP_CHARS) : '' };
    if (ok && typeof image === 'string' && image.length > 0 && image.length <= MAX_CLIP_B64) {
      const id = toB64url(randomBytes(9)), n = Math.ceil(image.length / CLIP_PART_CHARS);
      for (let i = 0; i < n; i++) this._send({ t: 'clip-part', id, i, n, data: image.slice(i * CLIP_PART_CHARS, (i + 1) * CLIP_PART_CHARS) });
      m.img = { id, mime: 'image/png' };
    }
    if (auto) m.auto = true;
    this._send(m);
  }

  // One piece of a clipboard image from the viewer. A new id starts over; pieces must come in order.
  _clipPart(msg) {
    const { id, i, n, data } = msg;
    const maxParts = Math.ceil(MAX_CLIP_B64 / CLIP_PART_CHARS);
    if (typeof id !== 'string' || id.length < 1 || id.length > 32 || !Number.isInteger(n) || n < 1 || n > maxParts ||
        !Number.isInteger(i) || i < 0 || i >= n || typeof data !== 'string' || data.length > CLIP_PART_CHARS || !B64_RE.test(data)) {
      this.clipIn = null;
      return;
    }
    if (i === 0) this.clipIn = { id, n, got: 0, parts: [] };
    const c = this.clipIn;
    if (!c || c.id !== id || c.n !== n || c.got !== i) { this.clipIn = null; return; }
    c.parts.push(data);
    c.got++;
  }
  sendClipSet(ok) { if (this.state === 'ready' && !this.guest) this._send({ t: 'clip-set', ok: !!ok }); }
  sendTextFocus(editable, secure) {
    if (this.state === 'ready' && !this.guest) this._send({ t: 'textfocus', editable: !!editable, secure: !!secure });
  }
  sendFit(ok) { if (this.state === 'ready' && !this.guest) this._send({ t: 'fit', ok: !!ok }); }
  sendMic(on, error) { if (this.state === 'ready' && !this.guest) this._send({ t: 'mic', on: !!on, ...(error ? { error } : {}) }); }

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
    for (const s of this.peerSubs) s.unSubscribe?.();
    this.peerSubs = [];
    if (wasReady) this.log?.info(`session ended (${reason})`);
    // A moment's grace so the last message (bye or denied) actually leaves before the connection closes.
    const closeTimer = setTimeout(() => this.peer.close(), CLOSE_DELAY_MS);
    closeTimer.unref?.();
    this.hub.sessionEnded(this, reason, wasReady);
  }
}

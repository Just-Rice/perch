// A stand-in for the Mac, for the website's browser tests: the Mac side of docs/PROTOCOL.md, written from the
// protocol alone (not from host/node/src), so the page is checked against the contract rather than against the
// other implementation. It uses the shared rendezvous code over the local test broker (tests/e2e/broker.mjs), werift
// for WebRTC and the same sign-in libraries as the real host, all from host/node/node_modules.
//
//   const mac = await FakeMac.start({ brokers: [broker.url], origin: 'http://localhost:1234', rpId: 'localhost' });
//   mac.pairingLink('http://localhost:1234/')  → a fresh connect.html#pair=… link
//   mac.code()                                  → the current 6-digit code
//   mac.behaviour.refuse = {reason: 'paused'}   → the next hello is turned down (see `behaviour` below)
//   await mac.waitFor(e => e.type === 'ready')  → everything that happens is logged in mac.events
//   mac.active.bye('idle'), mac.active.send({...})
//   await mac.close()
//
// Media: a 1440×900 H.264 test clip and an Opus tone (tests/site/lib/media.mjs), sent in real time after sign-in.
import { createRequire } from 'node:module';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  Rendezvous, hostTopic, nameTopic, replyTopic, hostEnvelopeKey, nameEnvelopeKey, normalizeMacName,
} from '../../site/js/shared/rendezvous.js';
import { bindingHash, bindProof } from '../../site/js/shared/bind.js';
import { toB64url, fromB64url, concat, equalBytes, fromUtf8 } from '../../site/js/shared/bytes.js';
import { PROTO, MIN_PEER_PROTO, CONTROL_CHANNEL, INPUT_CHANNEL, POINTER_CHANNEL, QUALITY } from '../../site/js/shared/proto.js';
import { makePairHash } from '../../site/js/ui/pairlink.js';
import { loadTestMedia, packetizeAccessUnit } from './lib/media.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(HERE, '../../host/node/package.json'));
const werift = require('werift');
const { verifyRegistrationResponse, verifyAuthenticationResponse } = require('@simplewebauthn/server');
const opaque = require('@serenity-kit/opaque');

export const DISPLAYS = [
  { id: 1, name: 'Built-in Retina Display', width: 1440, height: 900, main: true },
  { id: 2, name: 'Studio Display', width: 2560, height: 1440, main: false },
];

// werift falls back to Google's STUN server even with no ICE servers; tests must not touch the internet.
function noDefaultStun() {
  const proto = werift.Connection.prototype;
  if (proto.__perchNoDefaultStun) return;
  const orig = proto.applyStunTurnServersFromOptions;
  proto.applyStunTurnServersFromOptions = function () {
    orig.call(this);
    if (!this.options.stunServer) this.stunServer = undefined;
  };
  proto.__perchNoDefaultStun = true;
}

// --- authenticator codes (RFC 6238: HMAC-SHA1, 6 digits, 30 s) ---

export function totp(secret, t = Date.now(), offsetSteps = 0) {
  const step = Math.floor(t / 30000) + offsetSteps;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[19] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// --- the Mac ---

export class FakeMac {
  static async start(opts) {
    const mac = new FakeMac(opts);
    await mac._init();
    return mac;
  }

  constructor({ brokers, origin, rpId, macName = 'amber-otter-4821', password = 'correct horse battery', hv = '0.9.0-test',
    backup = true, log = () => {} }) {
    Object.assign(this, { brokers, origin, rpId, macName: normalizeMacName(macName), password, hv, backup, log });
    this.hostId = new Uint8Array(randomBytes(16));
    this.sigKey = new Uint8Array(randomBytes(32));
    this.totpSecret = randomBytes(20);
    this.devices = [];        // {id, publicKey, counter, transports, label}
    this.pairings = new Map(); // pairId b64url -> {secret, expires, used, bad}
    this.sessions = new Map(); // sid -> Session
    this.active = null;        // the signed-in session
    this.events = [];          // {type, sid?, ...} — everything worth checking in a test
    this.waiters = [];
    this.usedSteps = new Set();
    this.media = loadTestMedia();
    // What the next sessions do. Tests change these between runs.
    this.behaviour = {
      refuse: null,       // {reason, retryAfter?}: turn down hellos
      deny: null,         // {at: 'assert'|'opaque3'|'pair1'|'pair-cred'|'code', reason, retryAfter?}
      input: true,        // ready.input (false = view only)
      locked: false,
      audio: true,
      silent: false,      // ignore hellos altogether (the "Mac is off" case)
      displays: DISPLAYS,
    };
  }

  async _init() {
    noDefaultStun();
    await opaque.ready;
    this.serverSetup = opaque.server.createSetup();
    const reg = opaque.client.startRegistration({ password: this.password });
    const res = opaque.server.createRegistrationResponse({
      serverSetup: this.serverSetup, userIdentifier: this.macName, registrationRequest: reg.registrationRequest,
    });
    this.registrationRecord = opaque.client.finishRegistration({
      clientRegistrationState: reg.clientRegistrationState, registrationResponse: res.registrationResponse,
      password: this.password,
    }).registrationRecord;

    this.hostTopic = await hostTopic(this.hostId);
    this.hostKey = await hostEnvelopeKey(this.sigKey);
    this.nameTopic = await nameTopic(this.macName);
    this.nameKey = await nameEnvelopeKey(this.macName);
    this.rdv = new Rendezvous({ brokers: this.brokers, log: m => this.log(m) });
    await this.rdv.start(5000);
    await this.rdv.listen(this.hostTopic, this.hostKey, (m, i) => this._hello(m, i, 'host'));
    if (this.backup) await this.rdv.listen(this.nameTopic, this.nameKey, (m, i) => this._hello(m, i, 'name'));
  }

  get userHandle() { return concat(this.hostId, this.sigKey); }

  // A fresh pairing link, valid for 10 minutes and once.
  pairingLink(siteBase, { ttlMs = 600000 } = {}) {
    const pairId = new Uint8Array(randomBytes(16)), pairSecret = new Uint8Array(randomBytes(32));
    this.pairings.set(toB64url(pairId), { secret: pairSecret, expires: Date.now() + ttlMs, used: false, bad: 0 });
    return new URL('connect.html' + makePairHash({ hostId: this.hostId, sigKey: this.sigKey, pairId, pairSecret }), siteBase).href;
  }

  code(offsetSteps = 0) { return totp(this.totpSecret, Date.now(), offsetSteps); }

  // A code that is certainly wrong right now (not the previous, current or next one).
  wrongCode() {
    const ok = new Set([-1, 0, 1].map(o => this.code(o)));
    for (let n = 123456; ; n = (n + 111111) % 1e6) if (!ok.has(String(n).padStart(6, '0'))) return String(n).padStart(6, '0');
  }

  checkCode(code) {
    for (const o of [0, -1, 1]) {
      const step = Math.floor(Date.now() / 30000) + o;
      if (code === totp(this.totpSecret, Date.now(), o) && !this.usedSteps.has(step)) {
        this.usedSteps.add(step);
        return true;
      }
    }
    return false;
  }

  emit(e) {
    const ev = { at: Date.now(), ...e };
    this.events.push(ev);
    this.log(`fake-mac: ${JSON.stringify(ev).slice(0, 300)}`);
    for (const w of [...this.waiters]) if (w.pred(ev)) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(ev); }
  }

  // Resolves with the first event (already seen, after `since`, or still to come) that matches.
  waitFor(pred, { timeoutMs = 20000, since = 0, what = 'event' } = {}) {
    const seen = this.events.find(e => e.at >= since && pred(e));
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`fake Mac: timed out waiting for ${what}; last events: ${JSON.stringify(this.events.slice(-6))}`));
      }, timeoutMs) };
      this.waiters.push(w);
    });
  }

  async close() {
    for (const s of this.sessions.values()) await s.close('test over');
    this.rdv?.close();
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
  }

  // --- rendezvous ---

  async _hello(msg, { topic }, where) {
    if (msg.t === 'answer') return this.sessions.get(msg.sid)?.answer(msg.sdp);
    if (msg.t !== 'hello' || typeof msg.sid !== 'string' || this.sessions.has(msg.sid)) return;
    this.emit({ type: 'hello', sid: msg.sid, route: msg.route, label: msg.label, pv: msg.pv, pairId: msg.pairId });
    if (this.behaviour.silent) return;
    const key = where === 'name' ? this.nameKey : this.hostKey;
    const reply = replyTopic(topic, msg.sid);
    const refuse = (reason, retryAfter) => {
      this.emit({ type: 'refuse', sid: msg.sid, reason });
      return this.rdv.send(reply, key, { t: 'refuse', sid: msg.sid, reason, ...(retryAfter ? { retryAfter } : {}), pv: PROTO, minPv: MIN_PEER_PROTO, hv: this.hv });
    };
    if (this.behaviour.refuse) return refuse(this.behaviour.refuse.reason, this.behaviour.refuse.retryAfter);
    if (!(msg.pv >= MIN_PEER_PROTO)) return refuse('version');
    const okRoute = where === 'name' ? msg.route === 'backup' : msg.route === 'passkey' || msg.route === 'pair';
    if (!okRoute) return refuse('version');
    const s = new Session(this, { sid: msg.sid, route: msg.route, label: String(msg.label || '').slice(0, 48), reply, key });
    this.sessions.set(msg.sid, s);
    try {
      const sdp = await s.offer();
      await this.rdv.send(reply, key, { t: 'offer', sid: msg.sid, pv: PROTO, minPv: MIN_PEER_PROTO, hv: this.hv, sdp });
      this.emit({ type: 'offer', sid: msg.sid });
    } catch (e) {
      this.emit({ type: 'offer-failed', sid: msg.sid, error: e.message });
      s.close('offer failed');
    }
  }
}

// --- one viewer connection ---

class Session {
  constructor(mac, { sid, route, label, reply, key }) {
    Object.assign(this, { mac, sid, route, label, reply, key });
    this.state = 'new';
    this.inputs = [];      // {ch, msg} from the input and pointer channels
    this.control = [];     // every control message received
    this.codeTries = 0;
    this.subs = [];
    this.timers = [];
  }

  emit(e) { this.mac.emit({ sid: this.sid, route: this.route, ...e }); }

  async offer() {
    const { useH264, useOPUS, useNACK, usePLI, useREMB, useSdesMid, useAbsSendTime } = werift;
    const pc = this.pc = new werift.RTCPeerConnection({
      iceServers: [],
      codecs: {
        video: [useH264({ rtcpFeedback: [useNACK(), usePLI(), useREMB()],
          parameters: 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1' })],
        audio: [useOPUS({ parameters: 'minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1' })],
      },
      headerExtensions: { video: [useSdesMid(), useAbsSendTime()], audio: [useSdesMid()] },
      bundlePolicy: 'max-bundle',
      iceAdditionalHostAddresses: ['127.0.0.1'],
      iceUseIpv6: false,
    });
    this.video = pc.addTransceiver('video', { direction: 'sendonly' });
    this.audio = pc.addTransceiver('audio', { direction: 'sendonly' });
    this.ch = {
      [CONTROL_CHANNEL]: pc.createDataChannel(CONTROL_CHANNEL, { ordered: true }),
      [INPUT_CHANNEL]: pc.createDataChannel(INPUT_CHANNEL, { ordered: true }),
      [POINTER_CHANNEL]: pc.createDataChannel(POINTER_CHANNEL, { ordered: false, maxRetransmits: 0 }),
    };
    const ctl = this.ch[CONTROL_CHANNEL];
    this.subs.push(ctl.stateChanged.subscribe(st => {
      if (st === 'open') this._hi().catch(e => this.emit({ type: 'error', error: e.message }));
      if (st === 'closed') this.close('control closed');
    }));
    this.subs.push(ctl.onMessage.subscribe(d => this._control(d)));
    for (const label of [INPUT_CHANNEL, POINTER_CHANNEL]) {
      this.subs.push(this.ch[label].onMessage.subscribe(d => this._input(label, d)));
    }
    this.subs.push(pc.connectionStateChange.subscribe(st => {
      this.emit({ type: 'pc', state: st });
      if (st === 'failed' || st === 'closed') this.close('peer ' + st);
    }));
    this.subs.push(this.video.sender.onPictureLossIndication.subscribe(() => { this.emit({ type: 'pli' }); this.pump?.keyframe(); }));
    // Like the real Mac: give up on a sign-in that takes longer than 2 minutes (shorter when a test asks).
    this._timer(setTimeout(() => { if (this.state !== 'ready') this.deny('timeout'); }, this.mac.behaviour.authTimeoutMs ?? 120000));

    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') {
      await new Promise(resolve => {
        const t = setTimeout(resolve, 5000);
        const sub = pc.iceGatheringStateChange.subscribe(s => { if (s === 'complete') { clearTimeout(t); sub.unSubscribe(); resolve(); } });
      });
    }
    this.offerSdp = pc.localDescription.sdp;
    this.state = 'offered';
    return this.offerSdp;
  }

  async answer(sdp) {
    if (this.state !== 'offered' || typeof sdp !== 'string') return;
    this.state = 'connecting';
    this.answerSdp = sdp; // exactly as received: it is part of the binding
    this.emit({ type: 'answer' });
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  send(msg) {
    const ch = this.ch?.[CONTROL_CHANNEL];
    if (ch?.readyState !== 'open') return false;
    ch.send(JSON.stringify(msg));
    return true;
  }

  async _hi() {
    this.nonce = new Uint8Array(randomBytes(32));
    this.bind = await bindingHash(this.nonce, this.offerSdp, this.answerSdp);
    this.state = 'auth';
    this.step = { passkey: 'assert', backup: 'opaque1', pair: 'pair1' }[this.route];
    this.send({ t: 'hi', pv: PROTO, hv: this.mac.hv, nonce: toB64url(this.nonce), name: this.mac.macName, route: this.route });
    this.emit({ type: 'hi' });
  }

  _input(label, data) {
    if (this.state !== 'ready' || typeof data !== 'string') return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    this.inputs.push({ ch: label, msg });
    this.emit({ type: 'input', ch: label, msg });
  }

  async _control(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    this.control.push(msg);
    if (msg.t !== 'ping') this.emit({ type: 'control', msg: summarize(msg) });
    if (msg.t === 'bye') return this.close('viewer said bye', { viewerBye: true });
    if (this.state === 'ready') return this._during(msg);
    if (this.state !== 'auth') return;
    const deny = this.mac.behaviour.deny;
    if (deny && deny.at === msg.t) return this.deny(deny.reason, deny.retryAfter);
    try {
      if (msg.t === 'opaque-fail' && this.step === 'opaque3') return this.deny('wrong-password');
      if (msg.t !== this.step) return this.deny('protocol');
      await this[`_${msg.t.replace('-', '_')}`](msg);
    } catch (e) {
      this.emit({ type: 'auth-error', error: e.message });
      this.deny(e.reason || 'protocol');
    }
  }

  // --- sign-in steps ---

  async _assert({ response }) {
    const dev = this.mac.devices.find(d => d.id === response?.id);
    if (!dev) throw reasonError('unknown-device');
    if (response.rawId !== response.id) throw reasonError('bad-passkey');
    checkClientData(response, 'webauthn.get');
    if (response.response.userHandle && !equalBytes(fromB64url(response.response.userHandle), this.mac.userHandle)) {
      throw reasonError('bad-passkey');
    }
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: toB64url(this.bind), expectedOrigin: this.mac.origin, expectedRPID: this.mac.rpId,
      credential: { id: dev.id, publicKey: dev.publicKey, counter: dev.counter, transports: dev.transports },
      requireUserVerification: true,
    }).catch(e => { throw reasonError('bad-passkey', e.message); });
    if (!v.verified) throw reasonError('bad-passkey');
    dev.counter = v.authenticationInfo.newCounter;
    this.device = dev;
    this.emit({ type: 'assert-ok', credentialId: dev.id, userHandleSent: !!response.response.userHandle });
    this._askCode();
  }

  async _opaque1({ req }) {
    const r = opaque.server.startLogin({
      serverSetup: this.mac.serverSetup, userIdentifier: this.mac.macName,
      registrationRecord: this.mac.registrationRecord, startLoginRequest: req,
    });
    this.serverLoginState = r.serverLoginState;
    this.step = 'opaque3';
    this.send({ t: 'opaque2', res: r.loginResponse });
  }

  async _opaque3({ fin, proof }) {
    let r;
    try { r = opaque.server.finishLogin({ serverLoginState: this.serverLoginState, finishLoginRequest: fin }); } catch { r = null; }
    if (!r?.sessionKey) throw reasonError('wrong-password');
    const want = await bindProof(fromB64url(r.sessionKey), 'backup', this.bind);
    if (!equalBytes(fromB64url(proof), want)) throw reasonError('bad-proof');
    this.emit({ type: 'opaque-ok' });
    this._askCode();
  }

  async _pair1({ pairId, proof }) {
    const p = this.mac.pairings.get(pairId);
    if (!p) throw reasonError('bad-link');
    if (p.expires < Date.now()) throw reasonError('link-expired');
    if (p.used) throw reasonError('link-used');
    const want = await bindProof(p.secret, 'pair', this.bind);
    if (!equalBytes(fromB64url(proof), want)) {
      if (++p.bad >= 3) p.used = true;
      throw reasonError('bad-proof');
    }
    this.pairing = p;
    this.step = 'pair-cred';
    this.send({ t: 'pair-options', options: {
      challenge: toB64url(this.bind),
      rp: { id: this.mac.rpId, name: 'Perch' },
      user: { id: toB64url(this.mac.userHandle), name: `Perch · ${this.mac.macName}`, displayName: `Perch on ${this.mac.macName}` },
      pubKeyCredParams: [-7, -8, -257].map(alg => ({ type: 'public-key', alg })),
      timeout: 120000,
      excludeCredentials: this.mac.devices.map(d => ({ type: 'public-key', id: d.id })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
    } });
    this.emit({ type: 'pair-options' });
  }

  async _pair_cred({ response, label }) {
    checkClientData(response, 'webauthn.create');
    const v = await verifyRegistrationResponse({
      response, expectedChallenge: toB64url(this.bind), expectedOrigin: this.mac.origin, expectedRPID: this.mac.rpId,
      requireUserVerification: true,
    }).catch(e => { throw reasonError('bad-passkey', e.message); });
    if (!v.verified) throw reasonError('bad-passkey');
    const c = v.registrationInfo.credential;
    this.newDevice = { id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports, label: String(label || this.label) };
    this.emit({ type: 'pair-cred-ok', credentialId: c.id, label: this.newDevice.label });
    this._askCode();
  }

  _askCode() {
    this.step = 'code';
    this.send({ t: 'totp' });
  }

  async _code({ code }) {
    if (!this.mac.checkCode(String(code))) {
      this.emit({ type: 'wrong-code' });
      if (++this.codeTries >= 3) return this.deny('wrong-code');
      this.send({ t: 'denied', reason: 'wrong-code', final: false });
      return;
    }
    if (this.route === 'pair') {
      this.pairing.used = true;
      this.mac.devices.push(this.newDevice);
      this.device = this.newDevice;
      this.send({ t: 'paired', name: this.mac.macName, credentialId: this.newDevice.id });
    }
    this._ready();
  }

  _ready() {
    const b = this.mac.behaviour;
    const old = this.mac.active;
    if (old && old !== this) old.bye('signed-in-elsewhere');
    this.mac.active = this;
    this.state = 'ready';
    this.step = null;
    const main = b.displays.find(d => d.main) || b.displays[0];
    this.display = main.id;
    this.send({
      t: 'ready', name: this.mac.macName, hv: this.mac.hv, display: { id: main.id, width: main.width, height: main.height },
      displays: b.displays, quality: 'balanced', audio: b.audio, input: b.input, locked: b.locked,
    });
    this.emit({ type: 'ready' });
    this.pump = new MediaPump(this.video.sender, this.audio.sender, this.mac.media, { audio: b.audio });
    this.pump.start();
  }

  deny(reason, retryAfter) {
    if (this.state === 'ended') return;
    this.send({ t: 'denied', reason, ...(retryAfter ? { retryAfter } : {}), final: true });
    this.emit({ type: 'denied', reason });
    setTimeout(() => this.close('denied'), 300);
  }

  // --- signed in ---

  _during(msg) {
    switch (msg.t) {
      case 'ping': this.send({ t: 'pong', n: msg.n, ts: msg.ts }); break;
      case 'keyframe': this.pump?.keyframe(); break;
      case 'quality': if (msg.preset in QUALITY) this.quality = msg.preset; break;
      case 'display': {
        const d = this.mac.behaviour.displays.find(x => x.id === msg.id);
        if (d) { this.display = d.id; this.status({ width: d.width, height: d.height }); }
        break;
      }
    }
  }

  status(extra = {}) {
    const b = this.mac.behaviour;
    this.send({ t: 'status', locked: b.locked, link: 'good', kbps: 1500, fps: 30, width: 1440, height: 900, input: b.input, ...extra });
  }

  bye(reason) {
    this.send({ t: 'bye', reason });
    this.emit({ type: 'bye-sent', reason });
    setTimeout(() => this.close('bye ' + reason), 300);
  }

  async close(why, { viewerBye = false } = {}) {
    if (this.state === 'ended') return;
    const was = this.state;
    this.state = 'ended';
    this.pump?.stop();
    for (const t of this.timers) clearTimeout(t);
    for (const s of this.subs) { try { s.unSubscribe(); } catch {} }
    if (this.mac.active === this) this.mac.active = null;
    this.mac.sessions.delete(this.sid);
    this.emit({ type: 'closed', why, was, viewerBye });
    try { await this.pc?.close(); } catch {}
  }

  _timer(t) { this.timers.push(t); }
}

// Sends the test clip at 30 fps and the tone every 20 ms, looping, starting with a keyframe (and jumping to the next
// keyframe whenever one is asked for, like the real encoder being told to make one).
class MediaPump {
  constructor(video, audio, media, { audio: withAudio = true } = {}) {
    Object.assign(this, { video, audio, media, withAudio });
    this.frame = 0;
    this.vseq = randomBytes(2).readUInt16BE();
    this.vts = randomBytes(4).readUInt32BE();
    this.aseq = randomBytes(2).readUInt16BE();
    this.ats = randomBytes(4).readUInt32BE();
    this.apkt = 0;
    this.wantKey = false;
    this.sent = { frames: 0, audio: 0 };
  }

  keyframe() { this.wantKey = true; }

  start() {
    const t0 = performance.now();
    let nextV = t0, nextA = t0;
    const tick = () => {
      if (this.stopped) return;
      const now = performance.now();
      while (now >= nextA && this.withAudio) { this._audio(); nextA += 20; }
      while (now >= nextV) { this._video(); nextV += 1000 / 30; }
      this.timer = setTimeout(tick, Math.max(1, Math.min(this.withAudio ? nextA : Infinity, nextV) - performance.now()));
    };
    tick();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }

  _video() {
    const { aus } = this.media;
    if (this.wantKey) {
      this.wantKey = false;
      while (!aus[this.frame % aus.length].keyframe) this.frame++;
    }
    const au = aus[this.frame++ % aus.length];
    const pt = this.video.codec?.payloadType ?? 96;
    for (const p of packetizeAccessUnit(au.nals)) {
      this.vseq = (this.vseq + 1) & 0xffff;
      const header = new werift.RtpHeader({ payloadType: pt, sequenceNumber: this.vseq, timestamp: this.vts, marker: p.marker, ssrc: 0 });
      this.video.sendRtp(new werift.RtpPacket(header, p.payload))?.catch?.(() => {});
    }
    this.vts = (this.vts + 3000) >>> 0;
    this.sent.frames++;
  }

  _audio() {
    const { opus } = this.media;
    const data = opus[this.apkt++ % opus.length];
    this.aseq = (this.aseq + 1) & 0xffff;
    const pt = this.audio.codec?.payloadType ?? 111;
    const header = new werift.RtpHeader({ payloadType: pt, sequenceNumber: this.aseq, timestamp: this.ats, marker: this.apkt === 1, ssrc: 0 });
    this.audio.sendRtp(new werift.RtpPacket(header, data))?.catch?.(() => {});
    this.ats = (this.ats + 960) >>> 0;
    this.sent.audio++;
  }
}

// --- helpers ---

function reasonError(reason, detail = reason) {
  return Object.assign(new Error(detail), { reason });
}

// Perch's own check, for registration as well as sign-in: a passkey made or used inside another site's frame is refused.
function checkClientData(response, type) {
  let cd;
  try { cd = JSON.parse(fromUtf8(fromB64url(response.response.clientDataJSON))); } catch { throw reasonError('bad-passkey'); }
  if (cd.type !== type) throw reasonError('bad-passkey', `type ${cd.type}`);
  if (cd.crossOrigin === true || cd.topOrigin !== undefined) throw reasonError('origin', 'made inside a cross-origin frame');
  return cd;
}

// Control messages for the event log, without anything bulky.
function summarize(msg) {
  const out = { t: msg.t };
  for (const k of ['preset', 'id', 'code', 'label', 'pairId', 'n']) if (k in msg) out[k] = msg[k];
  if (msg.response) out.response = { id: msg.response.id, type: msg.response.type };
  return out;
}

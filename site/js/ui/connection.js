// One connection to a Mac, from "hello" on the public message services to a signed-in WebRTC session.
//
// 1. Rendezvous (docs/PROTOCOL.md, "Rendezvous"): listen on our own reply topic, say hello on the Mac's topic, wait for
//    its offer (or a refusal).
// 2. WebRTC: answer the offer once ICE gathering finishes (or after 3 s), send the complete answer back.
// 3. The Mac opens the control channel and says hi with a fresh nonce; both sides compute `bind` from the nonce and the
//    two SDP texts *exactly as sent and received* (shared/bind.js). Every sign-in proof is made over it.
//
// After that, control messages are handed out with next(types): the sign-in steps in ui/signin.js read them one at a
// time, and once signed in everything goes to onmessage for the viewer.
import { cleanIceServers, hasRelay } from '../shared/relay.js';
import { offerMatchesPin } from './quick.js';
import { Rendezvous, hostTopic, nameTopic, replyTopic, hostEnvelopeKey, nameEnvelopeKey } from '../shared/rendezvous.js';
import { bindingHash } from '../shared/bind.js';
import { toB64url, fromB64url, randomBytes } from '../shared/bytes.js';
import { PROTO, MIN_PEER_PROTO, CONTROL_CHANNEL, INPUT_CHANNEL, POINTER_CHANNEL } from '../shared/proto.js';

export const OFFER_TIMEOUT_MS = 15000; // the Mac answers a hello in well under a second when it is there
const BROKER_GRACE_MS = 2500;          // wait this long for the other message services before saying hello
const GATHER_MAX_MS = 3000;            // send the answer after this even if ICE gathering hasn't finished
const GATHER_RELAY_MAX_MS = 6000;      // ...longer when the Mac sent a relay: reaching it over port 443 can be slow
const HI_TIMEOUT_MS = 20000;           // from answer sent to the Mac's hi on the control channel
const LOST_AFTER_MS = 8000;            // "disconnected" this long counts as lost
const POINTER_BACKLOG = 64 * 1024;     // drop pointer moves while this much is still waiting to go out

// Every way a connection can fail, with a `kind` that ui/messages.js turns into words.
//   brokers, timeout, refuse {reason, retryAfter}, old-mac, webrtc, lost, bye {reason}, denied {reason, retryAfter,
//   final}, cancelled, protocol, plus sign-in kinds from ui/signin.js.
export class PerchError extends Error {
  constructor(kind, info = {}) {
    super(info.message || kind);
    this.name = 'PerchError';
    this.kind = kind;
    Object.assign(this, info);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Connection {
  // pin: the Mac's certificate pin (16 bytes), when known; certificate: an RTCCertificate to use (one-tap sign-in).
  constructor({ route, hostId, sigKey, macName, pairId, label, brokers, iceServers, pin = null, certificate = null,
    log = () => {}, onStage = () => {}, PeerConnection = globalThis.RTCPeerConnection }) {
    Object.assign(this, { route, hostId, sigKey, macName, pairId, label, brokers, iceServers, pin, certificate, log, onStage,
      PeerConnection });
    this.sid = toB64url(randomBytes(16));
    this.rdv = null;
    this.pc = null;
    this.channels = {};
    this.stream = null;
    this.offerSdp = null;
    this.answerSdp = null;
    this.bind = null;
    this.hi = null;
    this.live = false;       // signed in: messages go to onmessage
    this.closed = false;
    this.mailbox = [];       // control messages nobody has asked for yet
    this.waiters = [];       // {types, resolve, reject, timer}
    this.onmessage = () => {};
    this.onstream = () => {};
    this.onclose = () => {};   // (PerchError) once, when the connection ends for any reason but close()
    this.onlink = () => {};    // ('connected' | 'disconnected')
    let rejectFailed;
    this.failed = new Promise((_, reject) => { rejectFailed = reject; });
    this.failed.catch(() => {});
    this._rejectFailed = rejectFailed;
    this._lostTimer = null;
  }

  // Runs steps 1–3. Resolves to the Mac's hi message, with this.bind ready.
  async open() {
    const { route } = this;
    this.onStage('finding');
    const topic = route === 'backup' ? await nameTopic(this.macName) : await hostTopic(this.hostId);
    const key = route === 'backup' ? await nameEnvelopeKey(this.macName) : await hostEnvelopeKey(this.sigKey);
    this._check();
    this.rdv = new Rendezvous({ brokers: this.brokers, log: this.log });
    try {
      await this.rdv.start(10000);
    } catch {
      throw this._fail(new PerchError('brokers'));
    }
    this._check();
    // A hello only reaches the Mac through services both sides are connected to. Give the slower ones a moment.
    for (let t = 0; t < BROKER_GRACE_MS && this.rdv.connectedCount < this.brokers.length; t += 100) await sleep(100);
    this._check();

    let gotReply;
    const reply = new Promise(resolve => { gotReply = resolve; });
    await this.rdv.listen(replyTopic(topic, this.sid), key, msg => {
      if (msg.sid !== this.sid || (msg.t !== 'offer' && msg.t !== 'refuse')) return;
      // With a pin, only the Mac holding that certificate counts: anyone else who can seal messages for this topic
      // (an old pairing link, a removed device) is ignored, and we keep waiting for the real Mac.
      if (this.pin && msg.t === 'offer' && !offerMatchesPin(msg.sdp, this.pin)) {
        this.log('ignored an offer that is not from this Mac (certificate pin mismatch)');
        return;
      }
      gotReply(msg);
    });
    await this.rdv.send(topic, key, {
      t: 'hello', sid: this.sid, pv: PROTO, route, label: this.label,
      ...(this.pairId ? { pairId: toB64url(this.pairId) } : {}),
    });
    const first = await this._race(reply, OFFER_TIMEOUT_MS, () => new PerchError('timeout'));
    if (first.t === 'refuse') {
      throw this._fail(new PerchError('refuse', { reason: first.reason, retryAfter: first.retryAfter, hv: first.hv }));
    }
    if (!(Number(first.pv) >= MIN_PEER_PROTO) || typeof first.sdp !== 'string') throw this._fail(new PerchError('old-mac'));
    this.hv = first.hv;
    this.caps = Array.isArray(first.caps) ? first.caps.filter(c => typeof c === 'string') : [];

    this.onStage('connecting');
    this.offerSdp = first.sdp;
    // The Mac's own relay (if its owner set one up), for networks that block direct connections.
    this.relayServers = cleanIceServers(first.iceServers);
    await this._answer();
    await this.rdv.send(topic, key, { t: 'answer', sid: this.sid, sdp: this.answerSdp });

    this.onStage('checking');
    const hi = await this.next(['hi'], HI_TIMEOUT_MS, 'webrtc');
    // The rendezvous has done its job; don't keep three WebSockets open for the whole session.
    this.rdv.close();
    this.rdv = null;
    if (typeof hi.nonce !== 'string') throw this._fail(new PerchError('protocol', { message: 'hi without nonce' }));
    let nonce;
    try { nonce = fromB64url(hi.nonce); } catch { throw this._fail(new PerchError('protocol', { message: 'bad nonce' })); }
    this.bind = await bindingHash(nonce, this.offerSdp, this.answerSdp);
    this.hi = hi;
    return hi;
  }

  // The next control message whose type is in `types`. Rejects if the connection ends first, or after `timeoutMs`.
  next(types, timeoutMs = 30000, timeoutKind = 'lost') {
    if (this.closed) return Promise.reject(this._closedError || new PerchError('cancelled'));
    const i = this.mailbox.findIndex(m => types.includes(m.t));
    if (i >= 0) return Promise.resolve(this.mailbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { types, resolve, reject, timer: null };
      if (timeoutMs) {
        w.timer = setTimeout(() => {
          this.waiters = this.waiters.filter(x => x !== w);
          reject(this._fail(new PerchError(timeoutKind)));
        }, timeoutMs);
      }
      this.waiters.push(w);
    });
  }

  // Waits for something the user does (a tap, a code), but gives up if the connection ends meanwhile.
  guard(promise) {
    return Promise.race([promise, this.failed]);
  }

  // Signed in: from now on every control message goes to onmessage.
  goLive() {
    this.live = true;
    for (const m of this.mailbox.splice(0)) this._dispatch(m);
  }

  send(msg) { this._sendOn(CONTROL_CHANNEL, msg); }
  sendInput(msg) { this._sendOn(INPUT_CHANNEL, msg); }

  // Pointer moves go on the unordered channel; if it is backed up, newer moves will replace this one anyway.
  sendPointer(msg) {
    const ch = this.channels[POINTER_CHANNEL];
    if (ch && ch.readyState === 'open') {
      if (ch.bufferedAmount < POINTER_BACKLOG) ch.send(JSON.stringify(msg));
    } else {
      this.sendInput(msg);
    }
  }

  async getStats() { return this.pc ? this.pc.getStats() : new Map(); }

  // Ends the connection from this side. With bye, tells the Mac first so it can tidy up straight away.
  async close({ bye = true } = {}) {
    if (this.closed) return;
    const ctl = this.channels[CONTROL_CHANNEL];
    if (bye && ctl?.readyState === 'open') {
      try { ctl.send(JSON.stringify({ t: 'bye' })); } catch {}
      // Give the message a moment to leave before the connection goes away under it.
      for (let i = 0; i < 10 && ctl.bufferedAmount > 0; i++) await sleep(20);
      await sleep(50);
    }
    this._shutdown(new PerchError('cancelled'));
  }

  // --- internals ---

  async _answer() {
    let pc;
    try {
      pc = this.pc = new this.PeerConnection({
        iceServers: [...this.iceServers, ...(this.relayServers ?? [])],
        ...(this.certificate ? { certificates: [this.certificate] } : {}),
      });
    } catch (e) {
      throw this._fail(new PerchError('webrtc', { message: e.message }));
    }
    pc.ontrack = ev => {
      if (!this.stream) this.stream = new MediaStream();
      if (!this.stream.getTracks().includes(ev.track)) this.stream.addTrack(ev.track);
      try { this.onstream(this.stream, ev.track); } catch (e) { this.log(e); }
    };
    pc.ondatachannel = ev => this._adoptChannel(ev.channel);
    pc.onconnectionstatechange = () => this._linkState(pc.connectionState);
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: this.offerSdp });
      await pc.setLocalDescription(await pc.createAnswer());
    } catch (e) {
      throw this._fail(new PerchError('webrtc', { message: e.message }));
    }
    this._check();
    // No trickle ICE: the answer has to carry every candidate, so wait for gathering (but never too long).
    if (pc.iceGatheringState !== 'complete') {
      await new Promise(resolve => {
        const t = setTimeout(resolve, hasRelay(this.relayServers) ? GATHER_RELAY_MAX_MS : GATHER_MAX_MS);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
        });
      });
    }
    this._check();
    this.answerSdp = pc.localDescription.sdp;
  }

  _adoptChannel(ch) {
    this.channels[ch.label] = ch;
    if (ch.label !== CONTROL_CHANNEL) return;
    ch.onmessage = ev => {
      if (typeof ev.data !== 'string' || ev.data.length > 256 * 1024) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && typeof msg === 'object' && typeof msg.t === 'string') this._dispatch(msg);
    };
    ch.onclose = () => { if (!this.closed) this._shutdown(new PerchError(this.live ? 'lost' : 'webrtc')); };
  }

  _dispatch(msg) {
    const w = this.waiters.find(x => x.types.includes(msg.t));
    if (w) {
      this.waiters = this.waiters.filter(x => x !== w);
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    if (msg.t === 'bye') {
      this._shutdown(new PerchError('bye', { reason: msg.reason }), msg);
      return;
    }
    if (this.live) {
      try { this.onmessage(msg); } catch (e) { this.log(e); }
      return;
    }
    if (msg.t === 'denied' && msg.final !== false) {
      // The Mac gave up on this sign-in while we were waiting for the user (e.g. the 2-minute limit).
      this._shutdown(new PerchError('denied', { reason: msg.reason, retryAfter: msg.retryAfter, final: true }));
      return;
    }
    if (this.mailbox.length < 50) this.mailbox.push(msg);
  }

  _linkState(state) {
    if (this.closed) return;
    if (state === 'connected') {
      clearTimeout(this._lostTimer);
      this._lostTimer = null;
      this.onlink('connected');
    } else if (state === 'disconnected') {
      this.onlink('disconnected');
      if (!this._lostTimer) this._lostTimer = setTimeout(() => this._shutdown(new PerchError(this.live ? 'lost' : 'webrtc')), LOST_AFTER_MS);
    } else if (state === 'failed') {
      this._shutdown(new PerchError(this.live ? 'lost' : 'webrtc'));
    }
  }

  _sendOn(label, msg) {
    const ch = this.channels[label];
    if (ch && ch.readyState === 'open') ch.send(JSON.stringify(msg));
  }

  // Waits for a promise, but not longer than ms, and not past the connection ending.
  _race(promise, ms, onTimeout) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(this._fail(onTimeout())), ms); });
    return Promise.race([promise, timeout, this.failed]).finally(() => clearTimeout(timer));
  }

  _check() {
    if (this.closed) throw this._closedError || new PerchError('cancelled');
  }

  _fail(err) {
    this._shutdown(err);
    return err;
  }

  _shutdown(err, byeMsg) {
    if (this.closed) return;
    this.closed = true;
    this._closedError = err;
    clearTimeout(this._lostTimer);
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
    this._rejectFailed(err);
    try { this.rdv?.close(); } catch {}
    this.rdv = null;
    for (const ch of Object.values(this.channels)) { ch.onmessage = ch.onclose = null; try { ch.close(); } catch {} }
    try { this.pc?.close(); } catch {}
    if (err.kind !== 'cancelled') {
      try { this.onclose(err, byeMsg); } catch (e) { this.log(e); }
    }
  }
}

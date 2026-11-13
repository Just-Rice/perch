// The Mac's side of the Worker relay (docs/PROTOCOL.md, "Worker relay"): the owner's own Cloudflare Worker (relay/),
// used when a network blocks WebRTC. Unlike the TURN relay (relay.mjs) it needs no payment details and has no data
// allowance to use up: Workers don't charge for bandwidth.
//
// WorkerRelay is the setting (the Worker's address and the secret that proves this Mac owns it). WsPeer stands in for
// HostPeer once a viewer answers an offer over the relay: the same three channels and offer/answer texts, so the
// session (session.mjs) signs the viewer in exactly as it does over WebRTC. WsMediaSender stands in for MediaSender.
import { X509Certificate, sign, randomBytes } from 'node:crypto';
import {
  relayBase, roomUrl, roomAuth, checkAuth, newEcdh, offerSignedBytes, makeOffer, Channel, T, videoPayload, audioPayload,
  fromUtf8,
} from '../../../site/js/shared/wsrelay.js';
import { toB64url } from '../../../site/js/shared/bytes.js';
import { QUALITY, DEFAULT_QUALITY } from '../../../site/js/shared/proto.js';
import { BitrateController } from './media.mjs';

const PEER_TIMEOUT_MS = 20000;       // from opening the relay WebSocket to the viewer being there
const PING_EVERY_MS = 25000;
const AUDIO_BATCH = 3;               // Opus packets per message: fewer messages, 40 ms more sound delay at most
const KEYFRAME_MIN_GAP_MS = 500;

// --- the setting ---

export class WorkerRelay {
  constructor({ store, log = null, fetchImpl = globalThis.fetch, allowLocal = false, now = () => Date.now() }) {
    Object.assign(this, { store, log, fetchImpl, allowLocal, now });
    this.lastError = null;
    this.lastOkAt = null;
  }

  get configured() { return !!this.store.workerRelay; }
  get base() { return this.store.workerRelay?.url ?? null; }

  async _json(url, init = {}) {
    let res;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(10000) });
    } catch {
      throw new Error('Perch couldn’t reach the relay. Check its address and this Mac’s internet connection.');
    }
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, body };
  }

  // Checks the Worker at `url` is a Perch relay this Mac owns (claiming it if it's new), then saves it.
  async save(url) {
    const base = relayBase(url, { allowLocal: this.allowLocal });
    if (!base) throw new Error('That address doesn’t look right. It should look like https://perch-relay.your-name.workers.dev');
    const info = await this._json(`${base}/v1/info`);
    if (info.status !== 200 || info.body?.perch !== 'relay') {
      throw new Error('There’s no Perch relay at that address. Check you deployed the relay folder and copied its address.');
    }
    const known = this.store.workerRelay;
    let secret = known && known.url === base ? known.secret : null;
    if (!info.body.claimed) {
      secret = randomBytes(32).toString('hex');
      const claim = await this._json(`${base}/v1/claim`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret }),
      });
      if (claim.status !== 200) throw new Error('The relay wouldn’t accept this Mac as its owner. Try again in a minute.');
    } else if (!secret) {
      throw new Error('That relay already belongs to another Mac. Deploy a fresh copy (with a new name) for this one.');
    }
    await this.check({ url: base, secret });
    await this.store.setWorkerRelay({ url: base, secret });
    this.lastOkAt = this.now();
    this.lastError = null;
  }

  // Asks the relay whether this Mac's secret is still the right one. Throws with a plain message if not.
  async check(login = this.store.workerRelay) {
    const r = await this._json(`${login.url}/v1/check?auth=${await checkAuth(login.secret)}`);
    if (r.status !== 200 || r.body?.ok !== true) {
      throw new Error('The relay didn’t recognise this Mac. Remove it here, deploy a fresh copy and set it up again.');
    }
    return true;
  }

  // At startup: is the saved relay still there? (Only for the status shown in Setup; offers are made either way.)
  warm() {
    if (!this.configured) return;
    this.check().then(() => { this.lastOkAt = this.now(); this.lastError = null; },
      e => { this.lastError = e.message; this.log?.warn(`worker relay: ${e.message}`); });
  }

  async remove() {
    await this.store.setWorkerRelay(null);
    this.lastError = null;
    this.lastOkAt = null;
  }

  state() {
    return {
      set: this.configured,
      url: this.base,
      setAt: this.store.config.workerRelay?.setAt ?? null,
      working: this.configured ? (this.lastError ? false : this.lastOkAt ? true : null) : null,
      error: this.lastError,
    };
  }

  // A relay offer for one connection: a fresh room and ECDH key, signed with the Mac's DTLS certificate when it has
  // one (the key its pin names). Resolves to {offerText, base, room, privateKey, secret}.
  async prepare(sid, dtlsKeys) {
    const login = this.store.workerRelay;
    if (!login) return null;
    const room = toB64url(new Uint8Array(randomBytes(16)));
    const { privateKey, pub } = await newEcdh();
    let cert = null, sig = null;
    if (dtlsKeys?.certPem && dtlsKeys?.keyPem) {
      cert = new Uint8Array(new X509Certificate(dtlsKeys.certPem).raw);
      sig = new Uint8Array(sign('sha256', await offerSignedBytes({ sid, url: login.url, room, eph: pub }),
        { key: dtlsKeys.keyPem, dsaEncoding: 'ieee-p1363' }));
    }
    const offerText = makeOffer({ sid, url: login.url, room, eph: pub, cert, sig });
    return { offerText, base: login.url, room, privateKey, secret: login.secret };
  }
}

// --- a tiny event, with the subscribe/unSubscribe shape werift's events have (session.mjs uses those) ---

class Event {
  constructor(log) { this.fns = new Set(); this.log = log; }
  subscribe(fn) { this.fns.add(fn); return { unSubscribe: () => this.fns.delete(fn) }; }
  emit(...args) { for (const fn of [...this.fns]) { try { fn(...args); } catch (e) { this.log?.error('relay event handler:', e); } } }
}

// One of the three "channels" (control, input, pointer), as session.mjs expects of a WebRTC data channel.
class RelayChannel {
  constructor(peer, type, log) {
    this.peer = peer;
    this.type = type;
    this.readyState = 'connecting';
    this.stateChanged = new Event(log);
    this.onMessage = new Event(log);
  }
  get bufferedAmount() { return this.peer.bufferedAmount; }
  send(text) {
    if (this.readyState !== 'open') throw new Error('channel not open');
    this.peer._send(this.type, text);
  }
  _state(s) {
    if (this.readyState === s || this.readyState === 'closed') return;
    this.readyState = s;
    this.stateChanged.emit(s);
  }
}

// --- the connection ---

export class WsPeer {
  constructor({ url, offerText, answerText, keys, log = null, WebSocketImpl = globalThis.WebSocket }) {
    Object.assign(this, { url, log, WebSocketImpl });
    this.offerSdp = offerText;    // the binding (bind.js) is made over these texts, as over SDP with WebRTC
    this.answerSdp = answerText;
    this.transport = 'relay';
    this.onMicRtp = null;          // no microphone over the relay (yet)
    this.connectionState = 'new';
    this.stateChange = new Event(log);
    this.closed = false;
    this.channels = {
      control: new RelayChannel(this, T.CONTROL, log),
      input: new RelayChannel(this, T.INPUT, log),
      pointer: new RelayChannel(this, T.POINTER, log),
    };
    this.byType = { [T.CONTROL]: this.channels.control, [T.INPUT]: this.channels.input, [T.POINTER]: this.channels.pointer };
    this.channel = new Channel({
      keys,
      out: bytes => { try { this.ws?.send(bytes); } catch {} },
      deliver: (type, payload) => {
        const ch = this.byType[type];
        if (!ch || ch.readyState !== 'open') return; // the viewer sends no media; anything else is ignored
        ch.onMessage.emit(fromUtf8(payload));
      },
      onError: e => { this.log?.warn(`relay: ${e.message}`); this._down('failed'); },
    });
    this.ws = null;
    this.timers = [];
  }

  get bufferedAmount() { return (this.ws?.bufferedAmount ?? 0) + this.channel.queued; }

  connect() {
    this._state('connecting');
    let ws;
    try {
      ws = this.ws = new this.WebSocketImpl(this.url);
    } catch (e) {
      this.log?.warn(`relay: couldn’t open the WebSocket: ${e.message}`);
      return this._down('failed');
    }
    ws.binaryType = 'arraybuffer';
    const giveUp = setTimeout(() => {
      if (this.connectionState !== 'connected') { this.log?.info('relay: the viewer never arrived'); this._down('failed'); }
    }, PEER_TIMEOUT_MS);
    this.timers.push(giveUp);
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        if (ev.data === 'peer') this._up();
        return;
      }
      this.channel.open(new Uint8Array(ev.data));
    };
    ws.onclose = ev => {
      this.log?.info(`relay: closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`);
      this._down(this.connectionState === 'connected' ? 'closed' : 'failed');
    };
    ws.onerror = () => {}; // onclose follows
  }

  _up() {
    if (this.connectionState === 'connected' || this.closed) return;
    this._state('connected');
    this.timers.push(setInterval(() => { try { this.ws?.send('ping'); } catch {} }, PING_EVERY_MS));
    for (const ch of Object.values(this.channels)) ch._state('open');
  }

  _down(state) {
    if (this.connectionState === 'closed' || this.connectionState === 'failed') return;
    for (const ch of Object.values(this.channels)) ch._state('closed');
    this._state(state);
    this._stopTimers();
    try { this.ws?.close(); } catch {}
  }

  _state(s) {
    if (this.connectionState === s) return;
    this.connectionState = s;
    this.stateChange.emit(s);
  }

  _stopTimers() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
  }

  _send(type, payload) {
    if (this.connectionState !== 'connected') return;
    this.channel.send(type, payload);
  }

  onConnectionState(fn) {
    const sub = this.stateChange.subscribe(fn);
    return () => sub.unSubscribe();
  }

  createMediaSender(opts) { return new WsMediaSender({ peer: this, ...opts }); }

  dtlsInfo() { return null; }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this._down('closed');
  }
}

// --- media over the relay ---

// Whole H.264 frames and batches of Opus packets, sent as relay messages. There are no receiver reports over a
// WebSocket, so the link is judged by what can't leave: when the socket's send queue backs up, frames are dropped
// (and a keyframe asked for, since what follows a dropped frame can't be decoded) and the bitrate target comes down,
// through the same BitrateController the WebRTC sender uses.
export class WsMediaSender {
  constructor({ peer, quality = DEFAULT_QUALITY, log = null, onKeyframe = () => {}, onBitrate = () => {}, now = () => Date.now() }) {
    Object.assign(this, { peer, log, onKeyframe, now });
    this.enabled = false;
    this.waitingForKeyframe = true;
    this.lastKeyframeAsk = -Infinity;
    this.quality = QUALITY[quality] ? quality : DEFAULT_QUALITY;
    this.audioQueue = [];
    this.recent = [];
    this.recentBytes = 0;
    this.window = { sent: 0, dropped: 0 };
    this.counters = { since: now(), bytes: 0, frames: 0 };
    this.totals = { videoFrames: 0, dropped: 0, keyframes: 0, audioPackets: 0 };
    this.bitrate = new BitrateController({
      preset: QUALITY[this.quality], now, onTarget: kbps => onBitrate(kbps), sentKbps: () => this.sentKbps(),
    });
    this.tick = null;
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.waitingForKeyframe = true;
    this.counters = { since: this.now(), bytes: 0, frames: 0 };
    this.askKeyframe('session started');
    // Once a second: tell the bitrate controller how the link is doing.
    this.tick = setInterval(() => this._judge(), 1000);
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.quality = name;
    this.bitrate.setPreset(QUALITY[name]);
  }

  askKeyframe(why) {
    const t = this.now();
    if (t - this.lastKeyframeAsk < KEYFRAME_MIN_GAP_MS) return false;
    this.lastKeyframeAsk = t;
    this.log?.debug(`keyframe: ${why}`);
    this.onKeyframe();
    return true;
  }

  // How much may wait to be sent before frames are dropped: about half a second of the target bitrate.
  get _maxQueued() { return Math.max(256 * 1024, this.bitrate.target * 1000 / 8 / 2); }

  pushVideo({ keyframe, ptsUs, data }) {
    if (!this.enabled) return;
    if (this.peer.bufferedAmount > this._maxQueued) {
      // The link can't keep up: drop this frame, and start again from a keyframe once the queue has drained.
      this.window.dropped++;
      this.totals.dropped++;
      this.waitingForKeyframe = true;
      this.askKeyframe('relay backed up');
      return;
    }
    if (this.waitingForKeyframe) {
      if (!keyframe) { this.askKeyframe('waiting for a keyframe'); return; }
      this.waitingForKeyframe = false;
    }
    this._flushAudio();
    const bytes = data.length;
    this.peer._send(T.VIDEO, videoPayload({ keyframe, ptsUs, data }));
    this.window.sent++;
    this.counters.bytes += bytes;
    this.counters.frames++;
    this.totals.videoFrames++;
    if (keyframe) this.totals.keyframes++;
    this.recent.push([this.now(), bytes]);
    this.recentBytes += bytes;
  }

  pushAudio({ ptsUs, data }) {
    if (!this.enabled) return;
    this.audioQueue.push({ ptsUs, data: new Uint8Array(data) });
    this.totals.audioPackets++;
    if (this.audioQueue.length >= AUDIO_BATCH) this._flushAudio();
  }

  _flushAudio() {
    if (!this.audioQueue.length) return;
    const batch = this.audioQueue;
    this.audioQueue = [];
    // Sound is small; when the link is badly backed up it waits its turn like the rest rather than being dropped.
    this.peer._send(T.AUDIO, audioPayload(batch));
  }

  _judge() {
    const { sent, dropped } = this.window;
    this.window = { sent: 0, dropped: 0 };
    const total = sent + dropped;
    let fractionLost = total ? dropped / total : 0;
    // A queue that is growing but hasn't overflowed yet is the early sign: ease off before frames have to go.
    if (!fractionLost && this.peer.bufferedAmount > this._maxQueued / 2) fractionLost = 0.12;
    this.bitrate.onReport({ fractionLost, rtt: undefined });
  }

  sentKbps() {
    if (!this.enabled) return null;
    const cutoff = this.now() - 1000;
    let i = 0;
    while (i < this.recent.length && this.recent[i][0] < cutoff) this.recentBytes -= this.recent[i++][1];
    if (i) this.recent.splice(0, i);
    return this.recentBytes * 8 / 1000;
  }

  sample() {
    const t = this.now();
    const secs = Math.max(0.001, (t - this.counters.since) / 1000);
    const out = {
      kbps: Math.round(this.counters.bytes * 8 / secs / 1000),
      fps: Math.round(this.counters.frames / secs),
      target: this.bitrate.target,
      link: this.bitrate.link,
    };
    this.counters = { since: t, bytes: 0, frames: 0 };
    return out;
  }

  stop() {
    this.enabled = false;
    clearInterval(this.tick);
    this.tick = null;
    this.audioQueue = [];
  }
}

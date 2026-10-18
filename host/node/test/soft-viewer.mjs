// A viewer written in Node for host tests: it speaks the whole viewer side of the protocol (rendezvous, a WebRTC
// answer, binding, all three sign-in routes, the session messages) with werift standing in for the browser's
// WebRTC and test/soft-authenticator.mjs standing in for its passkeys. It records every RTP packet that arrives, so
// a test can check that nothing is sent before sign-in.
//
// `tamper` simulates someone in the middle of the rendezvous changing an SDP on its way: `tamper.offer` changes the
// offer before this viewer sees it, `tamper.answer` changes the answer after this viewer sent it. Either way the two
// sides end up binding over different texts, and every sign-in proof must fail.
import {
  RTCPeerConnection, useH264, useOPUS, useNACK, usePLI, useREMB, useSdesMid, useAbsSendTime,
} from 'werift';
import {
  Rendezvous, hostTopic, nameTopic, replyTopic, hostEnvelopeKey, nameEnvelopeKey,
} from '../../../site/js/shared/rendezvous.js';
import { bindingHash, bindProof, quickChallenge, sdpFingerprint } from '../../../site/js/shared/bind.js';
import { toB64url, fromB64url, randomBytes } from '../../../site/js/shared/bytes.js';
import { PROTO, HOST_ID_BYTES, SIG_KEY_BYTES, PAIR_ID_BYTES } from '../../../site/js/shared/proto.js';
import * as opaque from '@serenity-kit/opaque';
import { applyWeriftPatches, VIDEO_FMTP, OPUS_FMTP } from '../src/rtc.mjs';
import { depacketize, nalType } from '../src/h264.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Refused extends Error {
  constructor(msg) { super(`refused: ${msg.reason}`); this.msg = msg; this.reason = msg.reason; }
}

// pairing link → {hostId, sigKey, pairId, pairSecret} (docs/PROTOCOL.md, "Setup page")
export function parsePairLink(link) {
  const token = fromB64url(new URL(link).hash.replace(/^#pair=/, ''));
  let o = 0;
  const take = n => token.slice(o, (o += n));
  return { hostId: take(HOST_ID_BYTES), sigKey: take(SIG_KEY_BYTES), pairId: take(PAIR_ID_BYTES), pairSecret: take(32) };
}

// The passkey user handle carries the Mac's address: hostId ‖ sigKey.
export function addressFromUserHandle(userHandle) {
  const h = fromB64url(userHandle);
  return { hostId: h.slice(0, HOST_ID_BYTES), sigKey: h.slice(HOST_ID_BYTES, HOST_ID_BYTES + SIG_KEY_BYTES) };
}

export class SoftViewer {
  constructor({ brokers, authenticator = null, label = 'Soft viewer', log = () => {} }) {
    applyWeriftPatches();
    Object.assign(this, { brokers, authenticator, label, log });
    this.sid = toB64url(randomBytes(16));
    this.rv = null;
    this.pc = null;
    this.channels = {};
    this.mailbox = [];
    this.waiters = [];
    this.all = [];            // every control message, in order
    this.closed = false;
    this.offerSdp = null;     // as received (after any tampering)
    this.answerSdp = null;    // as this viewer made it (before any tampering)
    this.bind = null;
    this.hi = null;
    this.readyAt = null;
    this.media = { video: 0, audio: 0, videoBytes: 0, frames: 0, keyframes: 0, firstVideoAt: null, firstAudioAt: null,
      firstFrameNals: null, keyframesWithParams: 0 };
    this._fu = new Map();
  }

  // Rendezvous and WebRTC up to the Mac's `hi`. Throws Refused when the Mac refuses the hello.
  async open({ route, hostId, sigKey, macName, pairId, pv = PROTO, tamper = {}, timeoutMs = 15000, rawHello = null }) {
    this.route = route;
    const topic = route === 'backup' ? await nameTopic(macName) : await hostTopic(hostId);
    const key = route === 'backup' ? await nameEnvelopeKey(macName) : await hostEnvelopeKey(sigKey);
    this.rv = new Rendezvous({ brokers: this.brokers });
    await this.rv.start(5000);
    let gotReply;
    const reply = new Promise(r => { gotReply = r; });
    await this.rv.listen(replyTopic(topic, this.sid), key, msg => {
      if (msg.sid === this.sid && (msg.t === 'offer' || msg.t === 'refuse')) gotReply(msg);
    });
    const hello = rawHello ?? {
      t: 'hello', sid: this.sid, pv, route, label: this.label, ...(pairId ? { pairId: toB64url(pairId) } : {}),
    };
    await this.rv.send(topic, key, hello);
    const first = await withTimeout(reply, timeoutMs, 'no offer from the Mac');
    this.firstReply = first;
    if (first.t === 'refuse') {
      this.rv.close();
      throw new Refused(first);
    }
    this.offerSdp = tamper.offer ? tamper.offer(first.sdp) : first.sdp;
    this.pc = this._peer();
    await this.pc.setRemoteDescription({ type: 'offer', sdp: this.offerSdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForGathering(this.pc, 3000);
    this.answerSdp = this.pc.localDescription.sdp;
    await this.rv.send(topic, key, { t: 'answer', sid: this.sid, sdp: tamper.answer ? tamper.answer(this.answerSdp) : this.answerSdp });
    this.hi = await this.next(['hi'], timeoutMs);
    this.rv.close();
    this.rv = null;
    this.bind = await bindingHash(fromB64url(this.hi.nonce), this.offerSdp, this.answerSdp);
    return this.hi;
  }

  _peer() {
    const pc = new RTCPeerConnection({
      iceServers: [],
      iceAdditionalHostAddresses: ['127.0.0.1'],
      iceUseIpv6: false,
      bundlePolicy: 'max-bundle',
      codecs: {
        video: [useH264({ rtcpFeedback: [useNACK(), usePLI(), useREMB()], parameters: VIDEO_FMTP })],
        audio: [useOPUS({ parameters: OPUS_FMTP })],
      },
      headerExtensions: { video: [useSdesMid(), useAbsSendTime()], audio: [useSdesMid()] },
    });
    pc.onDataChannel.subscribe(ch => {
      this.channels[ch.label] = ch;
      if (ch.label === 'control') {
        ch.onMessage.subscribe(d => {
          let m;
          try { m = JSON.parse(d.toString()); } catch { return; }
          this.all.push(m);
          this._deliver(m);
        });
      }
    });
    pc.onTrack.subscribe(track => {
      track.onReceiveRtp.subscribe(rtp => this._rtp(track.kind, rtp));
    });
    pc.connectionStateChange.subscribe(s => {
      if (s === 'failed' || s === 'closed') this._fail(new Error(`connection ${s}`));
    });
    return pc;
  }

  _rtp(kind, rtp) {
    const t = Date.now();
    if (kind === 'audio') {
      this.media.audio++;
      this.media.firstAudioAt ??= t;
      return;
    }
    this.media.video++;
    this.media.videoBytes += rtp.payload.length;
    this.media.firstVideoAt ??= t;
    const ts = rtp.header.timestamp;
    if (!this._fu.has(ts)) this._fu.set(ts, []);
    this._fu.get(ts).push({ seq: rtp.header.sequenceNumber, payload: Buffer.from(rtp.payload) });
    if (!rtp.header.marker) return;
    const parts = this._fu.get(ts).sort((a, b) => ((a.seq - b.seq + 32768) & 0xffff) - 32768);
    this._fu.delete(ts);
    if (this._fu.size > 64) this._fu.clear();
    const types = depacketize(parts.map(p => p.payload)).map(nalType);
    this.media.frames++;
    this.media.firstFrameNals ??= types;
    if (types.includes(5)) {
      this.media.keyframes++;
      if (types.includes(7) && types.includes(8)) this.media.keyframesWithParams++;
    }
  }

  _deliver(m) {
    const i = this.waiters.findIndex(w => w.types.includes(m.t));
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
    } else this.mailbox.push(m);
  }

  _fail(err) {
    if (this.closed) return;
    this.failure = err;
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
  }

  // The next control message whose type is in `types`.
  next(types, timeoutMs = 10000) {
    const i = this.mailbox.findIndex(m => types.includes(m.t));
    if (i >= 0) return Promise.resolve(this.mailbox.splice(i, 1)[0]);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const w = { types, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(x => x !== w);
        reject(new Error(`timed out waiting for ${types.join('/')} (got ${this.all.map(m => m.t).join(',') || 'nothing'})`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  send(obj) { this.channels.control.send(JSON.stringify(obj)); }
  sendRaw(text) { this.channels.control.send(text); }
  sendInput(obj) { this.channels.input.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  sendPointer(obj) { this.channels.pointer.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }

  // --- the three routes; each resolves to the final message (ready, or denied with final) ---

  async _code(code, beforeCode) {
    let m = await this.next(['totp', 'denied']);
    if (m.t === 'denied') return m;
    await beforeCode?.();
    for (const c of Array.isArray(code) ? code : [code]) {
      this.send({ t: 'code', code: typeof c === 'function' ? await c() : c });
      m = await this.next(['ready', 'paired', 'denied']);
      if (m.t === 'paired') {
        this.paired = m;
        m = await this.next(['ready', 'denied']);
      }
      if (m.t === 'ready') {
        this.readyAt = Date.now();
        this.ready = m;
        return m;
      }
      if (m.final !== false) return m;
    }
    return m;
  }

  // `code` may be a value, a function (called when the Mac asks) or a list of them (tried in turn). `beforeCode`
  // runs once the Mac has asked for the code: the viewer has passed every other check but is not signed in yet.
  async signInPasskey({ credentialId, code, overrides = {}, beforeCode }) {
    const resp = this.authenticator.get({ challenge: toB64url(this.bind), credentialId }, overrides);
    this.send({ t: 'assert', response: resp });
    return this._code(code, beforeCode);
  }

  // One-tap sign-in (bind.js "quick"): the passkey signs this viewer's own certificate fingerprint, a time and a
  // fresh r instead of the Mac's nonce. `fingerprint`, `r` and `ts` can be overridden to test refusals.
  async signInQuick({ credentialId, code, r = randomBytes(16), ts = Date.now(), fingerprint, overrides = {}, beforeCode }) {
    const fp = fingerprint ?? sdpFingerprint(this.answerSdp);
    const challenge = await quickChallenge(r, ts, fp);
    const resp = this.authenticator.get({ challenge: toB64url(challenge), credentialId }, overrides);
    this.send({ t: 'assert', response: resp, quick: { r: toB64url(r), ts } });
    return this._code(code, beforeCode);
  }

  async signInPair({ pairId, pairSecret, code, createOverrides = {}, beforeCode }) {
    const proof = await bindProof(pairSecret, 'pair', this.bind);
    this.send({ t: 'pair1', pairId: toB64url(pairId), proof: toB64url(proof) });
    const m = await this.next(['pair-options', 'denied']);
    if (m.t === 'denied') return m;
    this.pairOptions = m.options;
    const resp = this.authenticator.create(m.options, createOverrides);
    this.credentialId = resp.id;
    this.send({ t: 'pair-cred', response: resp, label: this.label });
    return this._code(code, beforeCode);
  }

  async signInBackup({ password, code, beforeCode }) {
    await opaque.ready;
    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
    this.send({ t: 'opaque1', req: startLoginRequest });
    const m = await this.next(['opaque2', 'denied']);
    if (m.t === 'denied') return m;
    const fin = opaque.client.finishLogin({ clientLoginState, loginResponse: m.res, password });
    if (!fin) {
      this.send({ t: 'opaque-fail' });
      return this.next(['denied']);
    }
    const proof = await bindProof(fromB64url(fin.sessionKey), 'backup', this.bind);
    this.send({ t: 'opaque3', fin: fin.finishLoginRequest, proof: toB64url(proof) });
    return this._code(code, beforeCode);
  }

  // Waits until `pred(media)` holds.
  async waitForMedia(pred, timeoutMs = 10000) {
    const t0 = Date.now();
    while (!pred(this.media)) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`media did not arrive: ${JSON.stringify(this.media)}`);
      await sleep(25);
    }
    return this.media;
  }

  async close() {
    if (this.closed) return;
    this._fail(new Error('closed'));
    this.closed = true;
    this.rv?.close();
    try { await this.pc?.close(); } catch {}
  }
}

function waitForGathering(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    const sub = pc.iceGatheringStateChange.subscribe(s => { if (s === 'complete') done(); });
    function done() { clearTimeout(timer); sub.unSubscribe(); resolve(); }
  });
}

function withTimeout(p, ms, what) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what)), ms); })])
    .finally(() => clearTimeout(timer));
}

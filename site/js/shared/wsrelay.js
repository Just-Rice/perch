// The Worker relay (docs/PROTOCOL.md, "Worker relay"): when a network blocks WebRTC, the viewer and the Mac reach each
// other over WebSockets to the owner's own Cloudflare Worker (relay/), which passes bytes between them. This file is
// what both ends share: the offer and answer texts, the keys, and the encrypted framing. The Worker never sees a key.
//
// Offer (inside the sealed rendezvous offer): the Mac's fresh ECDH P-256 key, the relay's address and the room, and —
// when the Mac has its fixed DTLS certificate — that certificate and an ECDSA signature over all of it, so a viewer that
// knows the Mac's pin (passkey, pairing link, guest link) only talks to the real Mac. Answer: the viewer's fresh ECDH
// key. Both texts are used exactly as sent and received: they feed the keys and the sign-in binding (bind.js), so
// anything in the middle that swaps a key makes every sign-in proof fail, as it does for WebRTC.
//
// Every WebSocket message is [8-byte counter][AES-256-GCM ciphertext of: u8 flags · u8 type · payload]. Each direction
// has its own key; the counter is the GCM nonce and must go up by exactly one each message (WebSockets keep order), so
// nothing can be replayed, dropped or reordered unnoticed. Messages over CHUNK bytes are split (flag MORE).
import { utf8, fromUtf8, concat, toB64url, fromB64url, equalBytes, randomBytes, toHex } from './bytes.js';
import { sha256, hmacSha256 } from './crypto.js';

const subtle = globalThis.crypto.subtle;

export const WS_VERSION = 1;
export const CHUNK = 256 * 1024;
export const MAX_MESSAGE = CHUNK + 64;
export const MAX_ASSEMBLED = 8 * 1024 * 1024;   // a whole video frame, put back together
export const MAX_TEXT = 8 * 1024;               // offer and answer texts

// Message types (the byte after the flags).
export const T = Object.freeze({
  CONTROL: 1, INPUT: 2, POINTER: 3,   // UTF-8 JSON, like the WebRTC data channels of the same names
  VIDEO: 16,                          // u8 flags (bit 0 keyframe) · u64 pts µs · H.264 Annex-B access unit
  AUDIO: 17,                          // u8 count · count × (u64 pts µs · u16 length · Opus packet)
});
const MORE = 1;

const P256_SPKI_PREFIX = Uint8Array.from(
  '3059301306072a8648ce3d020106082a8648ce3d030107034200'.match(/../g), h => parseInt(h, 16));

// --- the relay's address ---

// https://<name>.workers.dev only (the website's Content-Security-Policy allows nothing else); in tests, also a
// loopback http address. Returns the normalized base URL ("https://x.y.workers.dev") or null.
export function relayBase(url, { allowLocal = false } = {}) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol === 'https:' && /^([a-z0-9-]+\.)+workers\.dev$/.test(u.hostname) && !u.port) return `https://${u.hostname}`;
  if (allowLocal && local && (u.protocol === 'http:' || u.protocol === 'https:')) return `${u.protocol}//${u.host}`;
  return null;
}

export function roomUrl(base, room, role, auth = null) {
  const ws = base.replace(/^http/, 'ws');
  return `${ws}/v1/room/${room}?role=${role}${auth ? `&auth=${auth}` : ''}`;
}

// What the Mac shows the relay to prove it is the relay's owner (the Worker checks the same HMAC).
export async function relayAuth(secretHex, label, room = '') {
  return toHex(await hmacSha256(utf8(secretHex), utf8(label + room)));
}
export const roomAuth = (secretHex, room) => relayAuth(secretHex, 'perch relay room v1', room);
export const checkAuth = secretHex => relayAuth(secretHex, 'perch relay check v1');

// --- keys ---

export async function newEcdh() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, pub };
}

// What the Mac's certificate signs: everything in the offer that matters.
export function offerSignedBytes({ sid, url, room, eph }) {
  return sha256(utf8('perch ws offer v1'), utf8(sid), utf8('\n'), utf8(url), utf8('\n'), utf8(room), eph);
}

export function makeOffer({ sid, url, room, eph, cert = null, sig = null }) {
  return JSON.stringify({ v: WS_VERSION, sid, url, room, eph: toB64url(eph),
    ...(cert && sig ? { cert: toB64url(cert), sig: toB64url(sig) } : {}) });
}

export function makeAnswer({ sid, eph }) {
  return JSON.stringify({ v: WS_VERSION, sid, eph: toB64url(eph) });
}

function parse(text, keys) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('relay text too long');
  const o = JSON.parse(text);
  if (!o || o.v !== WS_VERSION) throw new Error('unknown relay version');
  for (const k of keys) if (typeof o[k] !== 'string') throw new Error(`relay text without ${k}`);
  return o;
}

function point(b64) {
  const p = fromB64url(b64);
  if (p.length !== 65 || p[0] !== 4) throw new Error('not a P-256 point');
  return p;
}

// The viewer's check of the Mac's offer. With a pin, the offer must carry a certificate whose SHA-256 begins with the
// pin, and a valid signature by it. Resolves to {url, room, eph}.
export async function readOffer(text, { sid, pin = null, allowLocal = false }) {
  const o = parse(text, ['sid', 'url', 'room', 'eph']);
  if (o.sid !== sid) throw new Error('relay offer for another connection');
  const url = relayBase(o.url, { allowLocal });
  if (!url || url !== o.url) throw new Error('relay offer with an unusable address');
  if (!/^[A-Za-z0-9_-]{22}$/.test(o.room)) throw new Error('relay offer with a bad room');
  const eph = point(o.eph);
  if (o.cert !== undefined || pin) {
    if (typeof o.cert !== 'string' || typeof o.sig !== 'string') throw new Error('relay offer is not signed');
    const cert = fromB64url(o.cert);
    if (pin && !equalBytes((await sha256(cert)).slice(0, 16), pin)) throw new Error('relay offer from another Mac (pin)');
    const key = await subtle.importKey('spki', certSpki(cert), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(o.sig),
      await offerSignedBytes({ sid, url, room: o.room, eph }));
    if (!ok) throw new Error('relay offer signature is wrong');
  }
  return { url, room: o.room, eph };
}

export function readAnswer(text, { sid }) {
  const o = parse(text, ['sid', 'eph']);
  if (o.sid !== sid) throw new Error('relay answer for another connection');
  return { eph: point(o.eph) };
}

// The P-256 public key inside a DER certificate (Perch's DTLS certificates are always ECDSA P-256).
export function certSpki(cert) {
  for (let i = 0; i + P256_SPKI_PREFIX.length + 65 <= cert.length; i++) {
    let hit = true;
    for (let j = 0; j < P256_SPKI_PREFIX.length && hit; j++) hit = cert[i + j] === P256_SPKI_PREFIX[j];
    if (hit) return cert.slice(i, i + P256_SPKI_PREFIX.length + 65);
  }
  throw new Error('no P-256 key in the certificate');
}

// Two AES-GCM keys, one per direction, from ECDH and the exact offer and answer texts.
export async function sessionKeys(privateKey, theirEph, offerText, answerText, role) {
  const their = await subtle.importKey('raw', theirEph, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: their }, privateKey, 256));
  const salt = await sha256(utf8('perch ws salt v1'), await sha256(utf8(offerText)), await sha256(utf8(answerText)));
  const base = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const derive = info => subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const [toViewer, toMac] = await Promise.all([derive('perch ws mac to viewer v1'), derive('perch ws viewer to mac v1')]);
  return role === 'mac' ? { send: toViewer, recv: toMac } : { send: toMac, recv: toViewer };
}

// --- framing ---

const AAD = utf8('perch ws v1');
const iv = n => { const b = new Uint8Array(12); new DataView(b.buffer).setBigUint64(4, n); return b; };

// Seals and opens messages for one connection. send(type, payload) queues; out(bytes) is called in order with each
// encrypted message. open(bytes) takes messages in the order they arrived and calls deliver(type, payload) for each
// complete one. Any message that fails to decrypt, or arrives out of order, ends it (onError).
export class Channel {
  constructor({ keys, out, deliver, onError = () => {} }) {
    Object.assign(this, { keys, out, deliver, onError });
    this.sendN = 0n;
    this.recvN = 0n;
    this.sending = Promise.resolve();
    this.receiving = Promise.resolve();
    this.parts = [];
    this.partsBytes = 0;
    this.broken = false;
    this.queued = 0;  // bytes waiting to be encrypted
  }

  send(type, payload) {
    if (this.broken) return;
    const bytes = payload instanceof Uint8Array ? payload : utf8(String(payload));
    this.queued += bytes.length;
    this.sending = this.sending.then(async () => {
      for (let at = 0; ; at += CHUNK) {
        const piece = bytes.subarray(at, at + CHUNK);
        const last = at + CHUNK >= bytes.length;
        const plain = new Uint8Array(2 + piece.length);
        plain[0] = last ? 0 : MORE;
        plain[1] = type;
        plain.set(piece, 2);
        const n = this.sendN++;
        const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv(n), additionalData: AAD }, this.keys.send, plain));
        const msg = new Uint8Array(8 + sealed.length);
        new DataView(msg.buffer).setBigUint64(0, n);
        msg.set(sealed, 8);
        if (!this.broken) this.out(msg);
        if (last) break;
      }
      this.queued -= bytes.length;
    }).catch(e => this._fail(e));
  }

  open(data) {
    if (this.broken) return;
    const msg = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.receiving = this.receiving.then(async () => {
      if (this.broken) return;
      if (msg.length < 8 + 16 + 2 || msg.length > MAX_MESSAGE + 8 + 16) throw new Error('relay message of a bad size');
      const n = new DataView(msg.buffer, msg.byteOffset, 8).getBigUint64(0);
      if (n !== this.recvN) throw new Error(`relay message out of order (${n}, expected ${this.recvN})`);
      const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv(n), additionalData: AAD }, this.keys.recv, msg.subarray(8)));
      this.recvN++;
      const more = plain[0] & MORE;
      const type = plain[1];
      this.parts.push(plain.subarray(2));
      this.partsBytes += plain.length - 2;
      if (this.partsBytes > MAX_ASSEMBLED) throw new Error('relay message too big');
      if (more) return;
      const whole = this.parts.length === 1 ? this.parts[0] : concat(...this.parts);
      this.parts = [];
      this.partsBytes = 0;
      this.deliver(type, whole);
    }).catch(e => this._fail(e));
  }

  _fail(e) {
    if (this.broken) return;
    this.broken = true;
    try { this.onError(e); } catch {}
  }
}

// --- media payloads ---

export function videoPayload({ keyframe, ptsUs, data }) {
  const b = new Uint8Array(9 + data.length);
  const v = new DataView(b.buffer);
  v.setUint8(0, keyframe ? 1 : 0);
  v.setBigUint64(1, BigInt(Math.max(0, Math.round(ptsUs))));
  b.set(data, 9);
  return b;
}

export function readVideo(b) {
  if (b.length < 10) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  return { keyframe: !!(v.getUint8(0) & 1), ptsUs: Number(v.getBigUint64(1)), data: b.subarray(9) };
}

export function audioPayload(packets) {
  let size = 1;
  for (const p of packets) size += 10 + p.data.length;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint8(0, packets.length);
  let at = 1;
  for (const p of packets) {
    v.setBigUint64(at, BigInt(Math.max(0, Math.round(p.ptsUs))));
    v.setUint16(at + 8, p.data.length);
    b.set(p.data, at + 10);
    at += 10 + p.data.length;
  }
  return b;
}

export function readAudio(b) {
  if (b.length < 1) return [];
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  const count = v.getUint8(0);
  const out = [];
  let at = 1;
  for (let i = 0; i < count; i++) {
    if (at + 10 > b.length) return out;
    const ptsUs = Number(v.getBigUint64(at));
    const len = v.getUint16(at + 8);
    if (at + 10 + len > b.length) return out;
    out.push({ ptsUs, data: b.subarray(at + 10, at + 10 + len) });
    at += 10 + len;
  }
  return out;
}

export { randomBytes, fromUtf8, utf8 };

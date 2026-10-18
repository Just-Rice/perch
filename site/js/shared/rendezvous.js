// Rendezvous: how a viewer and a Mac find each other through public MQTT brokers before WebRTC takes over.
// Every message is sealed with AES-GCM (the topic is the additional data), published to every connected broker,
// and de-duplicated on arrival, so one broker going down changes nothing. Brokers only ever see ciphertext.
// See docs/PROTOCOL.md, "Rendezvous".
import { MqttClient } from './mqtt.js';
import { utf8, fromUtf8, toB64url, fromB64url, randomBytes } from './bytes.js';
import { sha256, hkdfAesKey, aesGcmEncrypt, aesGcmDecrypt } from './crypto.js';
import { BROKERS, ENVELOPE_MAX_BYTES, ENVELOPE_MAX_SKEW_MS, TOPIC_PREFIX } from './proto.js';

// --- names, topics and keys ---

export const MAC_NAME_RE = /^[a-z]{2,12}-[a-z]{2,12}-[0-9]{4}$/;

export function normalizeMacName(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

const shortHash = async (label, bytes) => toB64url(await sha256(utf8(label), bytes)).slice(0, 22);

export async function hostTopic(hostId) {
  return `${TOPIC_PREFIX}h/${await shortHash('perch topic v1', hostId)}`;
}

export async function nameTopic(macName) {
  return `${TOPIC_PREFIX}n/${await shortHash('perch name v1', utf8(normalizeMacName(macName)))}`;
}

export const replyTopic = (topic, sid) => `${topic}/${sid}`;

export const hostEnvelopeKey = sigKey => hkdfAesKey(sigKey, 'perch env v1', 'host');
export const nameEnvelopeKey = macName => hkdfAesKey(utf8(normalizeMacName(macName)), 'perch env v1', 'name');

// --- envelopes ---

export async function seal(key, topic, obj, now = Date.now()) {
  const iv = randomBytes(12);
  const ct = await aesGcmEncrypt(key, iv, utf8(JSON.stringify({ ...obj, ts: now })), utf8(topic));
  return JSON.stringify({ v: 1, i: toB64url(iv), c: toB64url(ct) });
}

// Resolves to {id, msg} or null for anything that isn't a fresh, authentic envelope for this topic.
export async function open(key, topic, payload, now = Date.now()) {
  if (payload.length > ENVELOPE_MAX_BYTES) return null;
  let env;
  try { env = JSON.parse(typeof payload === 'string' ? payload : fromUtf8(payload)); } catch { return null; }
  if (!env || env.v !== 1 || typeof env.i !== 'string' || typeof env.c !== 'string') return null;
  let iv, ct;
  try { iv = fromB64url(env.i); ct = fromB64url(env.c); } catch { return null; }
  if (iv.length !== 12) return null;
  const pt = await aesGcmDecrypt(key, iv, ct, utf8(topic));
  if (!pt) return null;
  let msg;
  try { msg = JSON.parse(fromUtf8(pt)); } catch { return null; }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return null;
  if (typeof msg.ts !== 'number' || Math.abs(now - msg.ts) > ENVELOPE_MAX_SKEW_MS) return null;
  return { id: env.i, msg };
}

// A broker that wants a (public) login carries it in its URL, like wss://public:public@public.cloud.shiftr.io. The
// login goes in MQTT's CONNECT; the WebSocket gets the plain URL (browsers don't send URL credentials).
export function brokerLogin(url) {
  let u;
  try { u = new URL(url); } catch { return [url, {}]; }
  if (!u.username && !u.password) return [url, {}];
  const login = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  u.username = '';
  u.password = '';
  return [u.href, login];
}

// --- the multi-broker client ---

export class Rendezvous {
  constructor({ brokers = BROKERS, WebSocketImpl = globalThis.WebSocket, log = () => {}, now = () => Date.now() } = {}) {
    this.brokers = brokers;
    this.WS = WebSocketImpl;
    this.log = log;
    this.now = now;
    this.clients = new Map(); // url -> {client, retry, timer}
    this.subs = new Map();    // topic -> {key, handler}
    this.seen = new Map();    // envelope id -> expiry
    this.closed = false;
    this.onstatus = () => {};
  }

  get connectedCount() {
    let n = 0;
    for (const c of this.clients.values()) if (c.client?.connected) n++;
    return n;
  }

  status() {
    return this.brokers.map(url => ({ url: brokerLogin(url)[0], connected: !!this.clients.get(url)?.client?.connected }));
  }

  // Resolves once at least one broker is connected; keeps (re)connecting to the rest in the background.
  start(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let failures = 0;
      const timer = setTimeout(() => reject(new Error('could not reach any rendezvous server')), timeoutMs);
      for (const url of this.brokers) {
        this.clients.set(url, { client: null, retry: 0, timer: null });
        this._dial(url,
          () => { clearTimeout(timer); resolve(); },
          () => {
            if (++failures === this.brokers.length && this.connectedCount === 0) {
              clearTimeout(timer);
              reject(new Error('could not reach any rendezvous server'));
            }
          });
      }
    });
  }

  async listen(topic, key, handler) {
    this.subs.set(topic, { key, handler });
    await Promise.allSettled([...this.clients.values()]
      .filter(c => c.client?.connected)
      .map(c => c.client.subscribe(topic)));
  }

  async unlisten(topic) {
    if (!this.subs.delete(topic)) return;
    await Promise.allSettled([...this.clients.values()]
      .filter(c => c.client?.connected)
      .map(c => c.client.unsubscribe(topic)));
  }

  // Publishes one sealed message to every connected broker. Resolves to how many took it.
  async send(topic, key, obj) {
    const env = await seal(key, topic, obj, this.now());
    let n = 0;
    for (const c of this.clients.values()) {
      if (!c.client?.connected) continue;
      try { c.client.publish(topic, env); n++; } catch {}
    }
    if (n === 0) throw new Error('no rendezvous server is connected');
    return n;
  }

  close() {
    this.closed = true;
    for (const c of this.clients.values()) {
      clearTimeout(c.timer);
      if (c.client) c.client.onclose = () => {};
      c.client?.close();
    }
    this.clients.clear();
    this.subs.clear();
  }

  // --- internals ---

  _dial(url, onFirstConnect, onFirstFail) {
    if (this.closed) return;
    const slot = this.clients.get(url);
    if (!slot) return;
    const [plainUrl, login] = brokerLogin(url);
    const client = new MqttClient(plainUrl, { WebSocketImpl: this.WS, ...login });
    slot.client = client;
    client.onmessage = (topic, payload) => this._receive(url, topic, payload);
    client.onclose = (reason) => {
      this.log(`rendezvous: lost ${url} (${reason})`);
      this.onstatus(this.status());
      this._retry(url);
    };
    client.connect().then(async () => {
      slot.retry = 0;
      this.log(`rendezvous: connected to ${url}`);
      await Promise.allSettled([...this.subs.keys()].map(t => client.subscribe(t)));
      this.onstatus(this.status());
      onFirstConnect?.();
    }, (err) => {
      this.log(`rendezvous: ${err.message}`);
      onFirstFail?.();
      this._retry(url);
    });
  }

  _retry(url) {
    const slot = this.clients.get(url);
    if (this.closed || !slot) return;
    clearTimeout(slot.timer);
    const delay = Math.min(30000, 1000 * 2 ** slot.retry++) * (0.75 + Math.random() / 2);
    slot.timer = setTimeout(() => this._dial(url), delay);
    slot.timer.unref?.();
  }

  async _receive(url, topic, payload) {
    const sub = this.subs.get(topic);
    if (!sub) return;
    const now = this.now();
    const opened = await open(sub.key, topic, payload, now);
    if (!opened || this.seen.has(opened.id)) return;
    this.seen.set(opened.id, now + 2 * ENVELOPE_MAX_SKEW_MS);
    if (this.seen.size > 2000) for (const [id, exp] of this.seen) if (exp < now) this.seen.delete(id);
    try { await sub.handler(opened.msg, { topic, broker: url }); } catch (e) { this.log(`rendezvous handler: ${e.message}`); }
  }
}

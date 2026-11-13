// Perch's Worker relay: the owner's own Cloudflare Worker, for networks that block the direct (WebRTC) connection.
// See docs/PROTOCOL.md, "Worker relay".
//
// It only ever passes bytes between two WebSockets, one from the Mac and one from the viewer, in a "room" the Mac
// names for each connection. Everything in them is end-to-end encrypted by Perch (site/js/shared/wsrelay.js), so this
// Worker can't see the screen, the sound, the sign-in or the input.
//
//   GET  /v1/info                         {perch: "relay", v, claimed}
//   POST /v1/claim  {secret}              the first Mac to call this owns the relay (or RELAY_SECRET, if set)
//   GET  /v1/check?auth=…                 200 when auth = HMAC(secret, "perch relay check v1")
//   GET  /v1/room/<room>?role=mac&auth=…  WebSocket; auth = HMAC(secret, "perch relay room v1" ‖ room)
//   GET  /v1/room/<room>?role=viewer      WebSocket; only paired with a Mac that opened the room
//   GET  /v1/mqtt                         WebSocket (subprotocol "mqtt"): a small rendezvous broker, see Broker
//   anything else                         the Perch website (site/), so it can be used from this address too
//
// Both sides get the text "peer" once the other is there; until then they must wait. Binary messages from one side go
// to the other unchanged. "ping" is answered with "pong" without waking the room.
import { DurableObject } from 'cloudflare:workers';

const VERSION = 1;
const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;      // 16 random bytes, base64url
const HEX64_RE = /^[0-9a-f]{64}$/;
const WAIT_FOR_PEER_MS = 30_000;            // a room whose other side never comes is closed after this
const MAX_MESSAGE = 1024 * 1024;            // Perch sends at most 256 KB at a time

const enc = new TextEncoder();
const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
});

async function hmacHex(secret, label, extra = '') {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(label + extra)));
  return Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
}

function sameHex(a, b) {
  if (typeof a !== 'string' || !HEX64_RE.test(a) || a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b));
}

// The relay's owner: one secret, set once by the first Mac to claim it (or by the RELAY_SECRET Worker secret).
export class Config extends DurableObject {
  async fetch(request) {
    const { op, secret } = await request.json();
    const stored = await this.ctx.storage.get('secret');
    if (op === 'get') return json({ secret: stored ?? null });
    if (op === 'claim') {
      if (!stored) {
        await this.ctx.storage.put('secret', secret);
        return json({ ok: true, fresh: true });
      }
      return json({ ok: stored === secret, fresh: false }, stored === secret ? 200 : 409);
    }
    return json({ error: 'unknown op' }, 400);
  }
}

async function ownerSecret(env) {
  if (env.RELAY_SECRET) return env.RELAY_SECRET;
  const stub = env.CONFIG.get(env.CONFIG.idFromName('config'));
  const res = await stub.fetch('https://config/', { method: 'POST', body: JSON.stringify({ op: 'get' }) });
  return (await res.json()).secret;
}

// One connection's meeting place: at most one Mac and one viewer.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role');
    if (role !== 'mac' && role !== 'viewer') return new Response('bad role', { status: 400 });
    // The viewer may only join a room its Mac opened (or opens within a moment).
    if (this.ctx.getWebSockets(role).length) return new Response('this side is already here', { status: 409 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    const other = this.ctx.getWebSockets(role === 'mac' ? 'viewer' : 'mac');
    if (other.length) {
      for (const ws of [server, ...other]) { try { ws.send('peer'); } catch {} }
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Date.now() + WAIT_FOR_PEER_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message === 'string') return; // only "ping", answered above; nothing else is meaningful as text
    if (message.byteLength > MAX_MESSAGE) return this._closeAll(1009, 'message too big');
    const role = this.ctx.getTags(ws)[0];
    for (const other of this.ctx.getWebSockets(role === 'mac' ? 'viewer' : 'mac')) {
      try { other.send(message); } catch {}
    }
  }

  // Either side leaving ends the connection for both: a room is never reused.
  webSocketClose(ws, code, reason) {
    this._closeAll(1000, 'the other side left', ws);
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch {}
  }

  webSocketError(ws) { this._closeAll(1011, 'the other side failed', ws); }

  async alarm() {
    if (this.ctx.getWebSockets('mac').length && this.ctx.getWebSockets('viewer').length) return;
    this._closeAll(4408, 'the other side never came');
  }

  _closeAll(code, reason, except = null) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.close(code, reason); } catch {}
    }
  }
}

// --- the rendezvous broker ---
//
// The public brokers Perch meets on (site/js/shared/proto.js BROKERS) may be blocked where the relay isn't. So the relay
// is one too: just enough MQTT 3.1.1 over WebSocket for Perch's own client (site/js/shared/mqtt.js): CONNECT, QoS 0
// PUBLISH and SUBSCRIBE (exact topics under perch/v1/, no wildcards), UNSUBSCRIBE, PINGREQ, DISCONNECT. Everything
// published is a sealed envelope (site/js/shared/rendezvous.js) that only the two ends can open. One Durable Object holds
// every connection; it hibernates between messages, and each socket's topics live in its attachment.

const MQTT = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, SUBSCRIBE: 8, SUBACK: 9, UNSUBSCRIBE: 10, UNSUBACK: 11,
  PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };
const TOPIC_RE = /^perch\/v1\/[A-Za-z0-9_\/-]{1,120}$/;
const MAX_TOPICS = 8;               // a Mac listens on 2 or 3, a viewer on 1
const MAX_PUBLISH = 70 * 1024;      // envelopes are at most 64 KB
const PUBLISH_BURST = 60;           // per connection, refilled at PUBLISH_RATE a second
const PUBLISH_RATE = 2;

function readVarInt(b, at) {
  let n = 0, mul = 1, i = at;
  for (;;) {
    if (i >= b.length) return null;
    const d = b[i++];
    n += (d & 0x7f) * mul;
    if (!(d & 0x80)) return [n, i];
    mul *= 128;
    if (mul > 128 ** 3) throw new Error('bad length');
  }
}

function varInt(n) {
  const out = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; out.push(d); } while (n);
  return out;
}

const mqttPacket = (first, body) => {
  const len = varInt(body.length);
  const p = new Uint8Array(1 + len.length + body.length);
  p[0] = first; p.set(len, 1); p.set(body, 1 + len.length);
  return p;
};

function readString(b, at) {
  if (at + 2 > b.length) throw new Error('short');
  const n = (b[at] << 8) | b[at + 1];
  if (at + 2 + n > b.length) throw new Error('short');
  return [new TextDecoder().decode(b.subarray(at + 2, at + 2 + n)), at + 2 + n];
}

export class Broker extends DurableObject {
  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ok: false, topics: [] });
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'mqtt' } });
  }

  webSocketMessage(ws, message) {
    if (typeof message === 'string') return this._drop(ws);
    const b = new Uint8Array(message);
    try {
      // A message holds whole packets (Perch's client sends one per message).
      for (let at = 0; at < b.length;) {
        const type = b[at] >> 4;
        const len = readVarInt(b, at + 1);
        if (!len || len[1] + len[0] > b.length) return this._drop(ws);
        const body = b.subarray(len[1], len[1] + len[0]);
        if (this._packet(ws, type, b[at] & 0x0f, body, b.subarray(at, len[1] + len[0])) === false) return;
        at = len[1] + len[0];
      }
    } catch {
      this._drop(ws);
    }
  }

  _packet(ws, type, flags, body, raw) {
    const st = ws.deserializeAttachment() ?? { ok: false, topics: [] };
    if (!st.ok && type !== MQTT.CONNECT) return this._drop(ws);
    switch (type) {
      case MQTT.CONNECT: {
        const [proto, at] = readString(body, 0);
        if (proto !== 'MQTT' || body[at] !== 4 || st.ok) return this._drop(ws);
        ws.serializeAttachment({ ok: true, topics: [], tokens: PUBLISH_BURST, at: Date.now() });
        ws.send(Uint8Array.of(MQTT.CONNACK << 4, 2, 0, 0));
        return true;
      }
      case MQTT.SUBSCRIBE: {
        if (flags !== 2) return this._drop(ws);
        const id = body.subarray(0, 2);
        const codes = [];
        for (let at = 2; at < body.length;) {
          const [topic, next] = readString(body, at);
          at = next + 1; // requested QoS
          const ok = TOPIC_RE.test(topic) && (st.topics.includes(topic) || st.topics.length < MAX_TOPICS);
          if (ok && !st.topics.includes(topic)) st.topics.push(topic);
          codes.push(ok ? 0 : 0x80);
        }
        ws.serializeAttachment(st);
        ws.send(mqttPacket(MQTT.SUBACK << 4, Uint8Array.from([...id, ...codes])));
        return true;
      }
      case MQTT.UNSUBSCRIBE: {
        if (flags !== 2) return this._drop(ws);
        for (let at = 2; at < body.length;) {
          const [topic, next] = readString(body, at);
          at = next;
          st.topics = st.topics.filter(t => t !== topic);
        }
        ws.serializeAttachment(st);
        ws.send(mqttPacket(MQTT.UNSUBACK << 4, body.subarray(0, 2)));
        return true;
      }
      case MQTT.PUBLISH: {
        if (flags & 0x06) return this._drop(ws); // QoS 0 only
        if (body.length > MAX_PUBLISH) return this._drop(ws);
        const [topic] = readString(body, 0);
        if (!TOPIC_RE.test(topic)) return true;
        // A small token bucket per connection, so nobody can turn the relay into a firehose.
        const now = Date.now();
        st.tokens = Math.min(PUBLISH_BURST, (st.tokens ?? PUBLISH_BURST) + (now - (st.at ?? now)) / 1000 * PUBLISH_RATE);
        st.at = now;
        if (st.tokens < 1) { ws.serializeAttachment(st); return true; }
        st.tokens -= 1;
        ws.serializeAttachment(st);
        const out = raw.slice();
        out[0] = MQTT.PUBLISH << 4; // no DUP or RETAIN on the way out
        for (const other of this.ctx.getWebSockets()) {
          const o = other.deserializeAttachment();
          if (o?.ok && o.topics.includes(topic)) { try { other.send(out); } catch {} }
        }
        return true;
      }
      case MQTT.PINGREQ:
        ws.send(Uint8Array.of(MQTT.PINGRESP << 4, 0));
        return true;
      case MQTT.DISCONNECT:
        try { ws.close(1000, 'bye'); } catch {}
        return false;
      default:
        return this._drop(ws);
    }
  }

  _drop(ws) {
    try { ws.close(1002, 'protocol error'); } catch {}
    return false;
  }

  webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/v1/info') {
      const secret = await ownerSecret(env);
      return json({ perch: 'relay', v: VERSION, claimed: !!secret });
    }

    if (path === '/v1/claim' && request.method === 'POST') {
      if (env.RELAY_SECRET) return json({ ok: false, error: 'This relay has a fixed secret (RELAY_SECRET).' }, 409);
      let secret;
      try { ({ secret } = await request.json()); } catch {}
      if (typeof secret !== 'string' || !HEX64_RE.test(secret)) return json({ ok: false, error: 'bad secret' }, 400);
      const stub = env.CONFIG.get(env.CONFIG.idFromName('config'));
      return stub.fetch('https://config/', { method: 'POST', body: JSON.stringify({ op: 'claim', secret }) });
    }

    if (path === '/v1/check') {
      const secret = await ownerSecret(env);
      if (!secret) return json({ ok: false, error: 'not claimed' }, 403);
      const ok = sameHex(url.searchParams.get('auth'), await hmacHex(secret, 'perch relay check v1'));
      return json({ ok, v: VERSION }, ok ? 200 : 403);
    }

    if (path === '/v1/mqtt') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
      const stub = env.BROKER.get(env.BROKER.idFromName('broker'));
      return stub.fetch(new Request('https://broker/', request));
    }

    const m = /^\/v1\/room\/([^/]+)$/.exec(path);
    if (m) {
      const room = m[1];
      if (!ROOM_RE.test(room)) return new Response('bad room', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
      const role = url.searchParams.get('role');
      if (role === 'mac') {
        const secret = await ownerSecret(env);
        if (!secret || !sameHex(url.searchParams.get('auth'), await hmacHex(secret, 'perch relay room v1', room))) {
          return new Response('not this relay’s Mac', { status: 403 });
        }
      } else if (role !== 'viewer') {
        return new Response('bad role', { status: 400 });
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(new Request(`https://room/?role=${role}`, request));
    }

    // The Perch website, served from this relay too (wrangler.toml, [assets]).
    if (env.ASSETS && !path.startsWith('/v1/')) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

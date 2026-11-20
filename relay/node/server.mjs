// Perch's relay as a plain Node.js server: the same protocol as the Cloudflare Worker (../src/index.js), for running
// on your own computer behind a tunnel (for example zrok) as a second relay. See README.md.
//
//   GET  /v1/info                         {perch: "relay", v, claimed}
//   POST /v1/claim  {secret}              the first Mac to call this owns the relay (or RELAY_SECRET, if set)
//   GET  /v1/check?auth=…                 200 when auth = HMAC(secret, "perch relay check v1")
//   GET  /v1/room/<room>?role=mac&auth=…  WebSocket; auth = HMAC(secret, "perch relay room v1" ‖ room)
//   GET  /v1/room/<room>?role=viewer      WebSocket; only paired with a Mac that opened the room
//   GET  /v1/mqtt                         WebSocket (subprotocol "mqtt"): the small rendezvous broker
//   anything else                         the Perch website (../../site)
//
// Settings (environment): PORT (8788), HOST (127.0.0.1), RELAY_SECRET (64 hex characters; otherwise the first Mac to
// claim the relay owns it, remembered in RELAY_DATA/secret), RELAY_DATA (~/.perch-relay), SITE_DIR (../../site).
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const VERSION = 1;
const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const WAIT_FOR_PEER_MS = 30_000;
const MAX_MESSAGE = 1024 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA = process.env.RELAY_DATA ?? join(homedir(), '.perch-relay');
const SITE = process.env.SITE_DIR ?? join(here, '..', '..', 'site');
const FIXED_SECRET = process.env.RELAY_SECRET || null;
if (FIXED_SECRET && !HEX64_RE.test(FIXED_SECRET)) throw new Error('RELAY_SECRET must be 64 hex characters');

const log = (...a) => console.log(new Date().toISOString(), ...a);

// --- the owner's secret ---

let claimed = null;
async function ownerSecret() {
  if (FIXED_SECRET) return FIXED_SECRET;
  if (claimed) return claimed;
  try { claimed = (await readFile(join(DATA, 'secret'), 'utf8')).trim() || null; } catch {}
  return claimed;
}

const hmacHex = (secret, label, extra = '') => createHmac('sha256', secret).update(label + extra).digest('hex');
function sameHex(a, b) {
  if (typeof a !== 'string' || !HEX64_RE.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// --- HTTP ---

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.sh': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}
const json = (res, body, status = 200) => send(res, status, JSON.stringify(body), {
  'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*',
});

async function readBody(req, limit = 4096) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('too big');
  }
  return body;
}

// Like Cloudflare's static assets: /connect serves connect.html, /dir/ serves dir/index.html.
async function serveSite(res, path) {
  let rel;
  try { rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''); } catch { return send(res, 400, 'bad path'); }
  const tries = rel.endsWith('/') ? [join(rel, 'index.html')] : extname(rel) ? [rel] : [`${rel}.html`, join(rel, 'index.html')];
  for (const t of tries) {
    const file = join(SITE, t);
    if (!file.startsWith(SITE)) continue;
    try {
      if (!(await stat(file)).isFile()) continue;
      return send(res, 200, await readFile(file), {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache',
      });
    } catch {}
  }
  send(res, 404, 'Not found');
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://relay');
    const path = url.pathname;
    if (path === '/v1/info') return json(res, { perch: 'relay', v: VERSION, claimed: !!(await ownerSecret()) });
    if (path === '/v1/claim' && req.method === 'POST') {
      if (FIXED_SECRET) return json(res, { ok: false, error: 'This relay has a fixed secret (RELAY_SECRET).' }, 409);
      let secret;
      try { ({ secret } = JSON.parse(await readBody(req))); } catch {}
      if (typeof secret !== 'string' || !HEX64_RE.test(secret)) return json(res, { ok: false, error: 'bad secret' }, 400);
      const stored = await ownerSecret();
      if (!stored) {
        await mkdir(DATA, { recursive: true, mode: 0o700 });
        await writeFile(join(DATA, 'secret'), secret, { mode: 0o600 });
        claimed = secret;
        log('claimed by a Mac');
        return json(res, { ok: true, fresh: true });
      }
      return json(res, { ok: stored === secret, fresh: false }, stored === secret ? 200 : 409);
    }
    if (path === '/v1/check') {
      const secret = await ownerSecret();
      if (!secret) return json(res, { ok: false, error: 'not claimed' }, 403);
      const ok = sameHex(url.searchParams.get('auth'), hmacHex(secret, 'perch relay check v1'));
      return json(res, { ok, v: VERSION }, ok ? 200 : 403);
    }
    if (path === '/v1/mqtt' || path.startsWith('/v1/room/')) return send(res, 426, 'expected a WebSocket');
    if (path.startsWith('/v1/')) return send(res, 404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveSite(res, path);
  } catch (e) {
    log('request failed:', e);
    if (!res.headersSent) send(res, 500, 'error');
  }
});

// --- rooms: one Mac and one viewer, bytes passed between them unchanged ---

const rooms = new Map(); // room -> {mac, viewer, timer}
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE + 1, perMessageDeflate: false });
const brokerWss = new WebSocketServer({
  noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false,
  handleProtocols: protos => (protos.has('mqtt') ? 'mqtt' : false),
});

function closeRoom(name, code, reason, except = null) {
  const r = rooms.get(name);
  if (!r) return;
  rooms.delete(name);
  clearTimeout(r.timer);
  for (const ws of [r.mac, r.viewer]) {
    if (ws && ws !== except) { try { ws.close(code, reason); } catch {} }
  }
}

function joinRoom(ws, name, role) {
  const r = rooms.get(name);
  if (!r) { try { ws.close(1000, 'the other side left'); } catch {} return; }
  r[role] = ws;
  const otherRole = role === 'mac' ? 'viewer' : 'mac';
  clearTimeout(r.timer);
  if (r[otherRole]) {
    for (const s of [ws, r[otherRole]]) { try { s.send('peer'); } catch {} }
  } else {
    r.timer = setTimeout(() => closeRoom(name, 4408, 'the other side never came'), WAIT_FOR_PEER_MS);
  }
  ws.on('message', (data, isBinary) => {
    if (!isBinary) { if (String(data) === 'ping') ws.send('pong'); return; }
    if (data.length > MAX_MESSAGE) return closeRoom(name, 1009, 'message too big');
    const other = rooms.get(name)?.[otherRole];
    if (other && other.readyState === 1) other.send(data, { binary: true });
  });
  ws.on('close', () => closeRoom(name, 1000, 'the other side left', ws));
  ws.on('error', () => closeRoom(name, 1011, 'the other side failed', ws));
}

// --- the rendezvous broker: just enough MQTT 3.1.1 for Perch (see ../src/index.js, Broker) ---

const MQTT = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, SUBSCRIBE: 8, SUBACK: 9, UNSUBSCRIBE: 10, UNSUBACK: 11,
  PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };
const TOPIC_RE = /^perch\/v1\/[A-Za-z0-9_\/-]{1,120}$/;
const MAX_TOPICS = 8;
const MAX_PUBLISH = 70 * 1024;
const PUBLISH_BURST = 60;
const PUBLISH_RATE = 2;
const brokerClients = new Map(); // ws -> state

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
function mqttPacket(first, body) {
  const len = varInt(body.length);
  const p = new Uint8Array(1 + len.length + body.length);
  p[0] = first; p.set(len, 1); p.set(body, 1 + len.length);
  return p;
}
function readString(b, at) {
  if (at + 2 > b.length) throw new Error('short');
  const n = (b[at] << 8) | b[at + 1];
  if (at + 2 + n > b.length) throw new Error('short');
  return [new TextDecoder().decode(b.subarray(at + 2, at + 2 + n)), at + 2 + n];
}

function brokerDrop(ws) {
  try { ws.close(1002, 'protocol error'); } catch {}
  return false;
}

function brokerPacket(ws, st, type, flags, body, raw) {
  if (!st.ok && type !== MQTT.CONNECT) return brokerDrop(ws);
  switch (type) {
    case MQTT.CONNECT: {
      const [proto, at] = readString(body, 0);
      if (proto !== 'MQTT' || body[at] !== 4 || st.ok) return brokerDrop(ws);
      Object.assign(st, { ok: true, topics: [], tokens: PUBLISH_BURST, at: Date.now() });
      ws.send(Uint8Array.of(MQTT.CONNACK << 4, 2, 0, 0));
      return true;
    }
    case MQTT.SUBSCRIBE: {
      if (flags !== 2) return brokerDrop(ws);
      const id = body.subarray(0, 2);
      const codes = [];
      for (let at = 2; at < body.length;) {
        const [topic, next] = readString(body, at);
        at = next + 1;
        const ok = TOPIC_RE.test(topic) && (st.topics.includes(topic) || st.topics.length < MAX_TOPICS);
        if (ok && !st.topics.includes(topic)) st.topics.push(topic);
        codes.push(ok ? 0 : 0x80);
      }
      ws.send(mqttPacket(MQTT.SUBACK << 4, Uint8Array.from([...id, ...codes])));
      return true;
    }
    case MQTT.UNSUBSCRIBE: {
      if (flags !== 2) return brokerDrop(ws);
      for (let at = 2; at < body.length;) {
        const [topic, next] = readString(body, at);
        at = next;
        st.topics = st.topics.filter(t => t !== topic);
      }
      ws.send(mqttPacket(MQTT.UNSUBACK << 4, body.subarray(0, 2)));
      return true;
    }
    case MQTT.PUBLISH: {
      if (flags & 0x06) return brokerDrop(ws);
      if (body.length > MAX_PUBLISH) return brokerDrop(ws);
      const [topic] = readString(body, 0);
      if (!TOPIC_RE.test(topic)) return true;
      const now = Date.now();
      st.tokens = Math.min(PUBLISH_BURST, st.tokens + (now - st.at) / 1000 * PUBLISH_RATE);
      st.at = now;
      if (st.tokens < 1) return true;
      st.tokens -= 1;
      const out = raw.slice();
      out[0] = MQTT.PUBLISH << 4;
      for (const [other, o] of brokerClients) {
        if (o.ok && o.topics.includes(topic) && other.readyState === 1) { try { other.send(out); } catch {} }
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
      return brokerDrop(ws);
  }
}

function brokerClient(ws) {
  const st = { ok: false, topics: [], tokens: PUBLISH_BURST, at: Date.now() };
  brokerClients.set(ws, st);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return brokerDrop(ws);
    const b = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    try {
      for (let at = 0; at < b.length;) {
        const len = readVarInt(b, at + 1);
        if (!len || len[1] + len[0] > b.length) return brokerDrop(ws);
        const body = b.subarray(len[1], len[1] + len[0]);
        if (brokerPacket(ws, st, b[at] >> 4, b[at] & 0x0f, body, b.subarray(at, len[1] + len[0])) === false) return;
        at = len[1] + len[0];
      }
    } catch {
      brokerDrop(ws);
    }
  });
  ws.on('close', () => brokerClients.delete(ws));
  ws.on('error', () => brokerClients.delete(ws));
}

// --- upgrades ---

function refuse(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
}

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://relay');
    if (url.pathname === '/v1/mqtt') return brokerWss.handleUpgrade(req, socket, head, brokerClient);
    const m = /^\/v1\/room\/([^/]+)$/.exec(url.pathname);
    if (!m) return refuse(socket, 404, 'Not found');
    const name = m[1];
    if (!ROOM_RE.test(name)) return refuse(socket, 400, 'bad room');
    const role = url.searchParams.get('role');
    if (role === 'mac') {
      const secret = await ownerSecret();
      if (!secret || !sameHex(url.searchParams.get('auth'), hmacHex(secret, 'perch relay room v1', name))) {
        return refuse(socket, 403, 'not this relay’s Mac');
      }
    } else if (role !== 'viewer') {
      return refuse(socket, 400, 'bad role');
    }
    const r = rooms.get(name);
    if (r?.[role]) return refuse(socket, 409, 'this side is already here');
    if (!r) rooms.set(name, { mac: null, viewer: null,
      timer: setTimeout(() => closeRoom(name, 4408, 'the other side never came'), WAIT_FOR_PEER_MS) });
    wss.handleUpgrade(req, socket, head, ws => joinRoom(ws, name, role));
  } catch (e) {
    log('upgrade failed:', e);
    try { socket.destroy(); } catch {}
  }
});

server.listen(PORT, HOST, () => log(`Perch relay listening on http://${HOST}:${PORT} (site: ${SITE})`));

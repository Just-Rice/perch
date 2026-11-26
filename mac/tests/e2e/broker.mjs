// A tiny local MQTT-over-WebSocket broker for tests, so no test depends on the public brokers.
// QoS 0 only, exact-match topics, no retained messages. Also a plain WebSocket server implementation (RFC 6455).
//   import { startBroker } from './broker.mjs';  const b = await startBroker();  b.url → 'ws://127.0.0.1:PORT/mqtt'
// Options: { port, dropRate (0..1, drop that share of publishes), delayMs }.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(payload, opcode = 2) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

class WsConn {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.onMessage = onMessage;
    this.closed = false;
    socket.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
    socket.on('close', () => { if (!this.closed) { this.closed = true; onClose(); } });
    socket.on('error', () => {});
  }
  send(bytes) { if (!this.closed) this.socket.write(encodeFrame(Buffer.from(bytes))); }
  close() { if (!this.closed) { try { this.socket.end(encodeFrame(Buffer.alloc(0), 8)); } catch {} this.socket.destroy(); } }
  _parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, o = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); o = 10; }
      const masked = b1 & 0x80;
      const need = o + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(o + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(o, o + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(need);
      const opcode = b0 & 0x0f, fin = b0 & 0x80;
      if (opcode === 8) { this.close(); return; }
      if (opcode === 9) { this.socket.write(encodeFrame(payload, 10)); continue; }
      if (opcode === 10) continue;
      if (opcode === 0 || opcode === 1 || opcode === 2) {
        this.frag.push(payload);
        if (fin) { const msg = Buffer.concat(this.frag); this.frag = []; this.onMessage(msg); }
      }
    }
  }
}

export async function startBroker({ port = 0, dropRate = 0, delayMs = 0 } = {}) {
  const subs = new Map(); // topic -> Set<client>
  const clients = new Set();
  const stats = { connects: 0, publishes: 0, delivered: 0, dropped: 0 };

  function sendPacket(client, first, body) {
    const rl = [];
    let n = body.length;
    do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; rl.push(b); } while (n > 0);
    client.ws.send(Buffer.concat([Buffer.from([first, ...rl]), body]));
  }

  function handlePacket(client, type, flags, p) {
    if (type === 1) { stats.connects++; sendPacket(client, 0x20, Buffer.from([0, 0])); }
    else if (type === 8) {
      const id = p.subarray(0, 2);
      let o = 2;
      const codes = [];
      while (o < p.length) {
        const tl = p.readUInt16BE(o);
        const topic = p.subarray(o + 2, o + 2 + tl).toString();
        o += 2 + tl + 1;
        if (!subs.has(topic)) subs.set(topic, new Set());
        subs.get(topic).add(client);
        client.topics.add(topic);
        codes.push(0);
      }
      sendPacket(client, 0x90, Buffer.concat([id, Buffer.from(codes)]));
    } else if (type === 10) {
      const id = p.subarray(0, 2);
      let o = 2;
      while (o < p.length) {
        const tl = p.readUInt16BE(o);
        const topic = p.subarray(o + 2, o + 2 + tl).toString();
        o += 2 + tl;
        subs.get(topic)?.delete(client);
        client.topics.delete(topic);
      }
      sendPacket(client, 0xb0, id);
    } else if (type === 3) {
      stats.publishes++;
      const tl = p.readUInt16BE(0);
      const topic = p.subarray(2, 2 + tl).toString();
      if (Math.random() < dropRate) { stats.dropped++; return; }
      const deliver = () => {
        for (const c of subs.get(topic) ?? []) {
          stats.delivered++;
          sendPacket(c, 0x30, Buffer.from(p));
        }
      };
      delayMs ? setTimeout(deliver, delayMs) : deliver();
    } else if (type === 12) sendPacket(client, 0xd0, Buffer.alloc(0));
    else if (type === 14) client.ws.close();
  }

  const server = createServer((req, res) => res.writeHead(426).end('MQTT over WebSocket only'));
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    const proto = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).includes('mqtt');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n${proto ? 'Sec-WebSocket-Protocol: mqtt\r\n' : ''}\r\n`);
    const client = { topics: new Set(), buf: Buffer.alloc(0) };
    client.ws = new WsConn(socket, (data) => {
      client.buf = Buffer.concat([client.buf, data]);
      for (;;) {
        if (client.buf.length < 2) return;
        let len = 0, mult = 1, i = 1, b;
        do { if (i >= client.buf.length) return; b = client.buf[i++]; len += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
        if (client.buf.length < i + len) return;
        const first = client.buf[0];
        const p = client.buf.subarray(i, i + len);
        client.buf = client.buf.subarray(i + len);
        try { handlePacket(client, first >> 4, first & 0x0f, p); } catch { client.ws.close(); return; }
      }
    }, () => {
      clients.delete(client);
      for (const t of client.topics) subs.get(t)?.delete(client);
    });
    clients.add(client);
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.address().port}/mqtt`;
  return {
    url,
    stats,
    set dropRate(v) { dropRate = v; },
    close: () => new Promise(r => { for (const c of clients) c.ws.close(); server.close(() => r()); }),
  };
}

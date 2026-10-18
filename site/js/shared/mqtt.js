// A small MQTT 3.1.1 client over WebSocket, enough for Perch's rendezvous: QoS 0 publish and subscribe.
// Runs unchanged in browsers and in Node 22+ (global WebSocket). One instance talks to one broker.
import { utf8, fromUtf8, concat, randomBytes, toHex } from './bytes.js';

const CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4, SUBSCRIBE = 8, SUBACK = 9;
const UNSUBSCRIBE = 10, UNSUBACK = 11, PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14;

function remainingLength(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Uint8Array.from(out);
}

function str(s) {
  const b = utf8(s);
  return concat(Uint8Array.of(b.length >> 8, b.length & 0xff), b);
}

const u16 = n => Uint8Array.of(n >> 8, n & 0xff);
const packet = (first, body) => concat(Uint8Array.of(first), remainingLength(body.length), body);

export class MqttClient {
  // `username`/`password`: some public brokers ask for a fixed public login (e.g. shiftr.io's "public"/"public").
  constructor(url, { WebSocketImpl = globalThis.WebSocket, keepalive = 30, maxPacket = 1 << 20, username = null, password = null } = {}) {
    this.url = url;
    this.username = username;
    this.password = password;
    this.WS = WebSocketImpl;
    this.keepalive = keepalive;
    this.maxPacket = maxPacket;
    this.ws = null;
    this.connected = false;
    this.buf = new Uint8Array(0);
    this.nextId = 1;
    this.pending = new Map(); // packet id -> {resolve, reject}
    this.onmessage = () => {};
    this.onclose = () => {};
    this.pingTimer = null;
    this.lastHeard = 0;
  }

  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { this._teardown(err.message); reject(err); } else resolve();
      };
      const timer = setTimeout(() => done(new Error(`timed out connecting to ${this.url}`)), timeoutMs);
      let ws;
      try {
        ws = new this.WS(this.url, ['mqtt']);
      } catch (e) {
        done(e);
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const clientId = 'perch-' + toHex(randomBytes(8));
        // Connect flags: clean session (0x02), plus username (0x80) and password (0x40) when given.
        const flags = 0x02 | (this.username != null ? 0x80 : 0) | (this.password != null ? 0x40 : 0);
        const body = concat(str('MQTT'), Uint8Array.of(4, flags), u16(this.keepalive), str(clientId),
          ...(this.username != null ? [str(this.username)] : []), ...(this.password != null ? [str(this.password)] : []));
        this._send(packet(CONNECT << 4, body));
      };
      ws.onmessage = (ev) => {
        this.lastHeard = Date.now();
        const data = typeof ev.data === 'string' ? utf8(ev.data) : new Uint8Array(ev.data);
        this.buf = this.buf.length ? concat(this.buf, data) : data;
        try {
          this._drain((type, p) => {
            if (type !== CONNACK) return false;
            if (p[1] === 0) {
              this.connected = true;
              this._startPing();
              done();
            } else {
              done(new Error(`broker refused connection (code ${p[1]})`));
            }
            return true;
          });
        } catch (e) {
          done(e);
          this._teardown(e.message);
        }
      };
      ws.onerror = () => done(new Error(`could not reach ${this.url}`));
      ws.onclose = () => {
        done(new Error(`connection to ${this.url} closed`));
        this._teardown('closed');
      };
    });
  }

  subscribe(topic) {
    const id = this._id();
    this._send(packet((SUBSCRIBE << 4) | 0x02, concat(u16(id), str(topic), Uint8Array.of(0))));
    return this._await(id);
  }

  unsubscribe(topic) {
    const id = this._id();
    this._send(packet((UNSUBSCRIBE << 4) | 0x02, concat(u16(id), str(topic))));
    return this._await(id);
  }

  publish(topic, payload) {
    const body = typeof payload === 'string' ? utf8(payload) : payload;
    this._send(packet(PUBLISH << 4, concat(str(topic), body)));
  }

  close() {
    if (this.ws && this.connected) {
      try { this._send(Uint8Array.of(DISCONNECT << 4, 0)); } catch {}
    }
    this._teardown('closed by us');
  }

  // --- internals ---

  _id() {
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffff ? 1 : this.nextId + 1;
    return id;
  }

  _await(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no reply from ${this.url}`));
      }, 8000);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
    });
  }

  _send(bytes) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error(`not connected to ${this.url}`);
    this.ws.send(bytes);
  }

  _startPing() {
    clearInterval(this.pingTimer);
    this.lastHeard = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > this.keepalive * 1500) {
        this._teardown('broker stopped answering');
        return;
      }
      try { this._send(Uint8Array.of(PINGREQ << 4, 0)); } catch {}
    }, (this.keepalive * 1000) / 2);
    // Don't let the ping timer alone keep a Node process alive.
    this.pingTimer.unref?.();
  }

  // Splits the receive buffer into whole packets. A WebSocket frame may hold part of a packet or several.
  _drain(intercept) {
    for (;;) {
      if (this.buf.length < 2) return;
      let len = 0, mult = 1, i = 1, b;
      do {
        if (i >= this.buf.length) return;
        if (i > 4) throw new Error('malformed packet length');
        b = this.buf[i++];
        len += (b & 0x7f) * mult;
        mult *= 128;
      } while (b & 0x80);
      if (len > this.maxPacket) throw new Error('packet too large');
      if (this.buf.length < i + len) return;
      const first = this.buf[0];
      const p = this.buf.subarray(i, i + len);
      this.buf = this.buf.subarray(i + len);
      const type = first >> 4;
      if (intercept && intercept(type, p)) continue;
      this._handle(type, first & 0x0f, p);
    }
  }

  _handle(type, flags, p) {
    if (type === PUBLISH) {
      const tlen = (p[0] << 8) | p[1];
      const topic = fromUtf8(p.subarray(2, 2 + tlen));
      let o = 2 + tlen;
      const qos = (flags >> 1) & 3;
      if (qos > 0) {
        const id = (p[o] << 8) | p[o + 1];
        o += 2;
        if (qos === 1) try { this._send(Uint8Array.of(PUBACK << 4, 2, id >> 8, id & 0xff)); } catch {}
      }
      try { this.onmessage(topic, p.slice(o)); } catch {}
    } else if (type === SUBACK || type === UNSUBACK) {
      const id = (p[0] << 8) | p[1];
      const w = this.pending.get(id);
      if (!w) return;
      this.pending.delete(id);
      if (type === SUBACK && p[2] === 0x80) w.reject(new Error(`broker refused subscription on ${this.url}`));
      else w.resolve();
    } else if (type === PINGRESP) {
      // lastHeard was already updated
    }
  }

  // onclose fires only for a connection that had been accepted; a failed connect() rejects instead.
  _teardown(reason) {
    const wasOpen = this.connected;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.connected = false;
    for (const w of this.pending.values()) w.reject(new Error(reason));
    this.pending.clear();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch {}
    }
    this.buf = new Uint8Array(0);
    if (wasOpen) try { this.onclose(reason); } catch {}
  }
}

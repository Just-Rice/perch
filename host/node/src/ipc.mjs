// IPC between the Swift app and this host process: the app writes frames to our stdin, we write frames to our
// stdout. Every frame is [u32 big-endian length of the rest][u8 type][payload]. See docs/PROTOCOL.md, "App ⇄ host
// process (IPC)".
//
// Pipes deliver bytes in arbitrary pieces, so FrameReader keeps whatever is left over and only hands out whole
// frames. Nothing else may ever be written to stdout: a single stray byte would desynchronise the app's reader.
import { EventEmitter } from 'node:events';

export const T = Object.freeze({
  HELLO: 0x01, VIDEO: 0x02, AUDIO: 0x03, EVENT: 0x04, COMMAND: 0x10, INPUT: 0x11,
});
const KNOWN = new Set(Object.values(T));

// A 4K keyframe at a high bitrate is a few MB at most; anything near this is a broken stream, not a frame.
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(type, payload = Buffer.alloc(0)) {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(body.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, body]);
}

export const encodeJson = (type, obj) => encodeFrame(type, Buffer.from(JSON.stringify(obj)));

// VIDEO: u8 flags (bit 0 keyframe) · u64 BE pts in µs · H.264 Annex-B access unit.
export function encodeVideo({ keyframe, ptsUs, data }) {
  const p = Buffer.allocUnsafe(9 + data.length);
  p[0] = keyframe ? 1 : 0;
  p.writeBigUInt64BE(BigInt(Math.max(0, Math.round(ptsUs))), 1);
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(p, 9);
  return encodeFrame(T.VIDEO, p);
}

export function parseVideo(payload) {
  if (payload.length < 10) return null;
  return { keyframe: (payload[0] & 1) === 1, ptsUs: Number(payload.readBigUInt64BE(1)), data: payload.subarray(9) };
}

// AUDIO: u64 BE pts in µs · one Opus packet.
export function encodeAudio({ ptsUs, data }) {
  const p = Buffer.allocUnsafe(8 + data.length);
  p.writeBigUInt64BE(BigInt(Math.max(0, Math.round(ptsUs))), 0);
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(p, 8);
  return encodeFrame(T.AUDIO, p);
}

export function parseAudio(payload) {
  if (payload.length < 9) return null;
  return { ptsUs: Number(payload.readBigUInt64BE(0)), data: payload.subarray(8) };
}

// Turns a byte stream into whole frames. push() returns the frames completed by this chunk.
export class FrameReader {
  constructor({ maxFrame = MAX_FRAME_BYTES } = {}) {
    this.maxFrame = maxFrame;
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
    const frames = [];
    for (;;) {
      if (this.length < 5) break;
      const len = this._peekUInt32();
      if (len < 1 || len > this.maxFrame) throw new Error(`IPC frame of ${len} bytes is not valid`);
      if (this.length < 4 + len) break;
      const bytes = this._take(4 + len);
      frames.push({ type: bytes[4], payload: bytes.subarray(5) });
    }
    return frames;
  }

  _peekUInt32() {
    const first = this.chunks[0];
    if (first.length >= 4) return first.readUInt32BE(0);
    return this._take(4, true).readUInt32BE(0);
  }

  // Removes (or with peek, copies) the first n bytes. Copies only when a frame spans several chunks.
  _take(n, peek = false) {
    const first = this.chunks[0];
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (!peek) {
        if (first.length === n) this.chunks.shift(); else this.chunks[0] = first.subarray(n);
        this.length -= n;
      }
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let o = 0, i = 0;
    while (o < n) {
      const c = this.chunks[i];
      const k = Math.min(c.length, n - o);
      c.copy(out, o, 0, k);
      o += k;
      if (k < c.length) {
        if (!peek) this.chunks[i] = c.subarray(k);
        break;
      }
      i++;
    }
    if (!peek) {
      // Drop the chunks used up in one go (shifting them one by one is slow when a frame came in tiny pieces).
      this.chunks.splice(0, i);
      this.length -= n;
    }
    return out;
  }
}

// The host's end of the pipe. Emits: 'hello' (obj), 'video' ({keyframe, ptsUs, data}), 'audio' ({ptsUs, data}),
// 'event' (obj), 'close' (), and 'error' (Error) for a broken stream. Unknown frame types are ignored so a newer
// app can talk to an older host.
export class HostIpc extends EventEmitter {
  constructor({ input = process.stdin, output = process.stdout, log = null } = {}) {
    super();
    // Not `this.input`: that is the method that sends INPUT frames.
    this.inStream = input;
    this.outStream = output;
    this.log = log;
    this.reader = new FrameReader();
    this.closed = false;
    input.on('data', chunk => this._onData(chunk));
    input.on('end', () => this._close());
    input.on('close', () => this._close());
    input.on('error', () => this._close());
    output.on?.('error', () => this._close());
  }

  _onData(chunk) {
    let frames;
    try { frames = this.reader.push(chunk); } catch (e) {
      this.emit('error', e);
      return;
    }
    for (const f of frames) this._dispatch(f);
  }

  _dispatch({ type, payload }) {
    try {
      if (type === T.VIDEO) {
        const v = parseVideo(payload);
        if (v) this.emit('video', v);
      } else if (type === T.AUDIO) {
        const a = parseAudio(payload);
        if (a) this.emit('audio', a);
      } else if (type === T.HELLO || type === T.EVENT) {
        let obj;
        try { obj = JSON.parse(payload.toString('utf8')); } catch { this.log?.warn('ipc: bad JSON from the app'); return; }
        if (!obj || typeof obj !== 'object') return;
        this.emit(type === T.HELLO ? 'hello' : 'event', obj);
      } else if (!KNOWN.has(type)) {
        this.log?.debug(`ipc: ignoring frame type ${type}`);
      }
    } catch (e) {
      this.log?.error('ipc: handler failed:', e);
    }
  }

  _close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _write(buf) {
    if (this.closed) return false;
    try { this.outStream.write(buf); return true; } catch { return false; }
  }

  // command('capture', {on: true, ...}) → {"c":"capture","on":true,...}
  command(c, fields = {}) {
    return this._write(encodeJson(T.COMMAND, { c, ...fields }));
  }

  // An input message that has already been validated (src/input.mjs).
  input(msg) {
    return this._write(encodeJson(T.INPUT, msg));
  }
}

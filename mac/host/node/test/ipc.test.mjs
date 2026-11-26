// IPC framing between the app and the host: whole frames out of arbitrary pieces, and the host's send helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import {
  T, FrameReader, HostIpc, encodeFrame, encodeJson, encodeVideo, parseVideo, encodeAudio, parseAudio, MAX_FRAME_BYTES,
} from '../src/ipc.mjs';

const frames = () => [
  encodeJson(T.HELLO, { app: 'Perch', version: '1.0.0', ipc: 1 }),
  encodeVideo({ keyframe: true, ptsUs: 123456789, data: randomBytes(70000) }),
  encodeAudio({ ptsUs: 2 ** 40 + 5, data: randomBytes(160) }),
  encodeJson(T.EVENT, { e: 'lock', locked: true, text: 'é ✓' }),
  encodeFrame(0x7e, Buffer.from('from a newer app')),
];

test('frames come out whole however the bytes are cut', () => {
  const all = Buffer.concat(frames());
  const expected = new FrameReader().push(all);
  assert.equal(expected.length, 5);
  for (const cut of [1, 2, 3, 4, 5, 7, 4096, 65536]) {
    const r = new FrameReader();
    const got = [];
    for (let o = 0; o < all.length; o += cut) got.push(...r.push(all.subarray(o, o + cut)));
    assert.equal(got.length, 5, `pieces of ${cut}`);
    for (let i = 0; i < 5; i++) {
      assert.equal(got[i].type, expected[i].type);
      assert.ok(got[i].payload.equals(expected[i].payload), `frame ${i}, pieces of ${cut}`);
    }
  }
  // Random cuts too.
  const r = new FrameReader();
  const got = [];
  for (let o = 0; o < all.length;) {
    const n = 1 + Math.floor(Math.random() * 3000);
    got.push(...r.push(all.subarray(o, o + n)));
    o += n;
  }
  assert.equal(got.length, 5);
  assert.equal(r.length, 0, 'nothing left over');
});

test('video and audio payloads round-trip', () => {
  const data = randomBytes(5000);
  const v = parseVideo(new FrameReader().push(encodeVideo({ keyframe: true, ptsUs: 987654321012, data }))[0].payload);
  assert.deepEqual({ keyframe: v.keyframe, ptsUs: v.ptsUs }, { keyframe: true, ptsUs: 987654321012 });
  assert.ok(Buffer.from(v.data).equals(data));
  const nk = parseVideo(new FrameReader().push(encodeVideo({ keyframe: false, ptsUs: 1, data }))[0].payload);
  assert.equal(nk.keyframe, false);
  const a = parseAudio(new FrameReader().push(encodeAudio({ ptsUs: 20000, data: data.subarray(0, 100) }))[0].payload);
  assert.equal(a.ptsUs, 20000);
  assert.equal(a.data.length, 100);
  assert.equal(parseVideo(Buffer.alloc(9)), null, 'no picture data');
  assert.equal(parseAudio(Buffer.alloc(8)), null, 'no packet');
});

test('a broken length is an error, not a hang', () => {
  const zero = Buffer.from([0, 0, 0, 0, 1]);
  assert.throws(() => new FrameReader().push(zero), /not valid/);
  const huge = Buffer.alloc(5);
  huge.writeUInt32BE(MAX_FRAME_BYTES + 1);
  assert.throws(() => new FrameReader().push(huge), /not valid/);
});

function pipePair() {
  const input = new PassThrough();
  const output = new PassThrough();
  const ipc = new HostIpc({ input, output });
  const out = new FrameReader();
  const sent = [];
  output.on('data', d => sent.push(...out.push(d)));
  return { input, output, ipc, sent };
}

test('the host side emits hello, events, video, audio; ignores unknown types and bad JSON', async () => {
  const { input, ipc } = pipePair();
  const seen = [];
  for (const name of ['hello', 'event', 'video', 'audio']) ipc.on(name, v => seen.push([name, v]));
  const all = Buffer.concat([...frames(), encodeFrame(T.EVENT, Buffer.from('{not json')), encodeFrame(T.EVENT, Buffer.from('7'))]);
  for (let o = 0; o < all.length; o += 1000) input.write(all.subarray(o, o + 1000));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(seen.map(s => s[0]), ['hello', 'video', 'audio', 'event']);
  assert.equal(seen[0][1].version, '1.0.0');
  assert.equal(seen[1][1].keyframe, true);
  assert.equal(seen[1][1].data.length, 70000);
  assert.equal(seen[3][1].text, 'é ✓');
});

test('the host side writes commands and input as frames, and only frames', async () => {
  const { ipc, sent, output } = pipePair();
  let raw = Buffer.alloc(0);
  output.on('data', d => { raw = Buffer.concat([raw, d]); });
  assert.equal(ipc.command('capture', { on: true, kbps: 5000 }), true);
  assert.equal(ipc.input({ t: 'k', c: 'KeyA', k: 'a', d: true, m: 0 }), true);
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, T.COMMAND);
  assert.deepEqual(JSON.parse(sent[0].payload), { c: 'capture', on: true, kbps: 5000 });
  assert.equal(sent[1].type, T.INPUT);
  assert.deepEqual(JSON.parse(sent[1].payload), { t: 'k', c: 'KeyA', k: 'a', d: true, m: 0 });
  // Exactly the two frames: [len][type][json] each.
  assert.equal(raw.length, sent.reduce((n, f) => n + 5 + f.payload.length, 0));
});

test('a broken stream is reported, and closing stdin closes the link', async () => {
  const { input, ipc } = pipePair();
  const errors = [];
  let closed = false;
  ipc.on('error', e => errors.push(e));
  ipc.on('close', () => { closed = true; });
  input.write(Buffer.from([0, 0, 0, 0, 9]));
  await new Promise(r => setImmediate(r));
  assert.equal(errors.length, 1);
  input.end();
  await new Promise(r => setImmediate(r));
  assert.equal(closed, true);
  assert.equal(ipc.command('status', {}), false, 'nothing is written after close');
});

// The Worker relay on the Mac's side (src/wsrelay.mjs): claiming and checking the owner's relay, the signed offer, the
// relay peer standing in for WebRTC (channels, keys, the viewer arriving and leaving), and sending media over a link
// that backs up. The Worker is replaced by a stand-in fetch and an in-memory WebSocket pair; tests/e2e/relay.test.mjs
// runs the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { ensureDtlsIdentity } from '../src/rtc.mjs';
import { WorkerRelay, WsPeer, WsMediaSender } from '../src/wsrelay.mjs';
import * as W from '../../../site/js/shared/wsrelay.js';

const BASE = 'https://perch-relay.someone.workers.dev';
const store = async () => Store.open({ home: mkdtempSync(join(tmpdir(), 'perch-wsrelay-')), secrets: 'file' });

// A stand-in relay Worker: /v1/info, /v1/claim, /v1/check, with the same rules as relay/src/index.js.
function fakeWorker({ claimedBy = null, down = false, notPerch = false } = {}) {
  const w = { secret: claimedBy, calls: [] };
  w.fetchImpl = async (url, opts = {}) => {
    w.calls.push({ url, method: opts.method ?? 'GET' });
    if (down) throw new Error('offline');
    const u = new URL(url);
    const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });
    if (notPerch) return reply(200, { hello: 'world' });
    if (u.pathname === '/v1/info') return reply(200, { perch: 'relay', v: 1, claimed: !!w.secret });
    if (u.pathname === '/v1/claim') {
      const { secret } = JSON.parse(opts.body);
      if (!w.secret) { w.secret = secret; return reply(200, { ok: true }); }
      return reply(w.secret === secret ? 200 : 409, { ok: w.secret === secret });
    }
    if (u.pathname === '/v1/check') {
      const ok = !!w.secret && u.searchParams.get('auth') === await W.checkAuth(w.secret);
      return reply(ok ? 200 : 403, { ok });
    }
    return reply(404, null);
  };
  return w;
}

test('saving a relay claims it, keeps its secret out of config.json, and works again for the same Mac', async () => {
  const s = await store();
  const worker = fakeWorker();
  const r = new WorkerRelay({ store: s, fetchImpl: worker.fetchImpl });
  assert.equal(r.configured, false);
  await r.save(`${BASE}/`);
  assert.match(worker.secret, /^[0-9a-f]{64}$/, 'claimed with a fresh secret');
  assert.deepEqual(s.workerRelay, { url: BASE, secret: worker.secret });
  assert.ok(!JSON.stringify(s.config).includes(worker.secret), 'the secret is not in config.json');
  assert.equal(s.config.workerRelay.url, BASE);
  assert.equal(r.state().working, true);
  await r.save(BASE); // the same relay again: already ours
  assert.equal(s.workerRelay.secret, worker.secret);
  await r.remove();
  assert.equal(s.workerRelay, null);
  assert.equal(r.state().set, false);
});

test('a relay owned by another Mac, a wrong address or an outage is refused with a plain message', async () => {
  const s = await store();
  const taken = new WorkerRelay({ store: s, fetchImpl: fakeWorker({ claimedBy: 'cd'.repeat(32) }).fetchImpl });
  await assert.rejects(taken.save(BASE), /already belongs to another Mac/);
  await assert.rejects(new WorkerRelay({ store: s, fetchImpl: fakeWorker().fetchImpl }).save('https://example.com'), /doesn’t look right/);
  await assert.rejects(new WorkerRelay({ store: s, fetchImpl: fakeWorker({ notPerch: true }).fetchImpl }).save(BASE), /no Perch relay/);
  await assert.rejects(new WorkerRelay({ store: s, fetchImpl: fakeWorker({ down: true }).fetchImpl }).save(BASE), /couldn’t reach/);
  await assert.rejects(new WorkerRelay({ store: s, fetchImpl: fakeWorker().fetchImpl }).save('http://localhost:8787'), /doesn’t look right/,
    'loopback only in test mode');
  assert.equal(s.workerRelay, null, 'nothing saved');
});

test('the offer is signed with the Mac’s own certificate, so a viewer holding its pin accepts only it', async () => {
  const s = await store();
  const worker = fakeWorker();
  const r = new WorkerRelay({ store: s, fetchImpl: worker.fetchImpl });
  await r.save(BASE);
  await ensureDtlsIdentity(s);
  const sid = 'S'.repeat(22);
  const prep = await r.prepare(sid, s.dtlsKeys);
  assert.equal(prep.base, BASE);
  assert.match(prep.room, /^[A-Za-z0-9_-]{22}$/);
  const got = await W.readOffer(prep.offerText, { sid, pin: s.dtlsPin });
  assert.equal(got.room, prep.room);
  await assert.rejects(W.readOffer(prep.offerText, { sid, pin: new Uint8Array(16) }), /another Mac/);
  assert.notEqual((await r.prepare(sid, s.dtlsKeys)).room, prep.room, 'a fresh room every time');
});

// --- an in-memory relay: two sockets, "peer" once both are there, binary passed across ---

class FakeSocket {
  constructor(url) { this.url = url; this.binaryType = 'blob'; this.bufferedAmount = 0; this.sent = []; this.other = null; this.closed = false; }
  send(data) {
    if (this.closed) throw new Error('closed');
    if (typeof data === 'string') return;
    this.sent.push(data);
    const copy = new Uint8Array(data).slice().buffer;
    queueMicrotask(() => this.other?.onmessage?.({ data: copy }));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: '' }));
    this.other?.close();
  }
}

async function relayPair() {
  const sid = 'S'.repeat(22);
  const mac = await W.newEcdh(), viewer = await W.newEcdh();
  const offerText = W.makeOffer({ sid, url: BASE, room: 'R'.repeat(22), eph: mac.pub });
  const answerText = W.makeAnswer({ sid, eph: viewer.pub });
  const macKeys = await W.sessionKeys(mac.privateKey, viewer.pub, offerText, answerText, 'mac');
  const viewerKeys = await W.sessionKeys(viewer.privateKey, mac.pub, offerText, answerText, 'viewer');
  let macSocket;
  const peer = new WsPeer({ url: 'wss://relay/room', offerText, answerText, keys: macKeys,
    WebSocketImpl: class extends FakeSocket { constructor(u) { super(u); macSocket = this; } } });
  const viewerSide = { got: [], socket: new FakeSocket('viewer') };
  viewerSide.channel = new W.Channel({
    keys: viewerKeys,
    out: b => viewerSide.socket.send(b),
    deliver: (type, p) => viewerSide.got.push([type, type === W.T.VIDEO ? W.readVideo(p) : W.fromUtf8(p)]),
  });
  viewerSide.socket.onmessage = ev => viewerSide.channel.open(new Uint8Array(ev.data));
  peer.connect();
  macSocket.other = viewerSide.socket;
  viewerSide.socket.other = macSocket;
  return { peer, macSocket, viewer: viewerSide, offerText, answerText };
}

test('the relay peer: channels open when the viewer arrives, messages go both ways, and leaving closes it', async () => {
  const { peer, macSocket, viewer, offerText, answerText } = await relayPair();
  assert.equal(peer.offerSdp, offerText, 'the binding is made over the relay texts');
  assert.equal(peer.answerSdp, answerText);
  const states = [];
  peer.channels.control.stateChanged.subscribe(s => states.push(s));
  const fromViewer = [];
  peer.channels.input.onMessage.subscribe(m => fromViewer.push(m));
  assert.equal(peer.channels.control.readyState, 'connecting');
  assert.throws(() => peer.channels.control.send('{}'), /not open/, 'nothing goes out before the viewer is there');

  macSocket.onmessage({ data: 'peer' });
  assert.deepEqual(states, ['open']);
  assert.equal(peer.connectionState, 'connected');
  peer.channels.control.send('{"t":"hi"}');
  viewer.channel.send(W.T.INPUT, '{"t":"m","x":0.5,"y":0.5}');
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(viewer.got, [[W.T.CONTROL, '{"t":"hi"}']]);
  assert.deepEqual(fromViewer, ['{"t":"m","x":0.5,"y":0.5}']);

  viewer.socket.close();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(states, ['open', 'closed']);
  assert.equal(peer.connectionState, 'closed');
});

test('media over the relay: frames go whole, and a backed-up link drops frames, asks for a keyframe and slows down', async () => {
  const { peer, macSocket, viewer } = await relayPair();
  macSocket.onmessage({ data: 'peer' });
  let t = 0;
  const keyframes = [];
  const targets = [];
  const media = new WsMediaSender({ peer, now: () => t, onKeyframe: () => keyframes.push(t), onBitrate: k => targets.push(k) });
  media.start();
  assert.equal(keyframes.length, 1, 'a keyframe is asked for at the start');
  const frame = (keyframe, n = 1000) => ({ keyframe, ptsUs: t * 1000, data: new Uint8Array(n).fill(keyframe ? 1 : 2) });
  media.pushVideo(frame(false));
  assert.equal(media.totals.videoFrames, 0, 'nothing before the first keyframe');
  media.pushVideo(frame(true));
  media.pushVideo(frame(false));
  media.pushAudio({ ptsUs: 0, data: Buffer.alloc(60) });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(media.totals.videoFrames, 2);
  assert.deepEqual(viewer.got.map(g => [g[0], g[1].keyframe]), [[W.T.VIDEO, true], [W.T.VIDEO, false]]);

  // The link backs up: frames are dropped (not queued), a keyframe is asked for, and the target bitrate comes down.
  const before = media.bitrate.target;
  macSocket.bufferedAmount = 10 * 1024 * 1024;
  t += 600;
  for (let i = 0; i < 5; i++) media.pushVideo(frame(false));
  assert.equal(media.totals.dropped, 5);
  assert.equal(keyframes.length, 2, 'asked for a fresh keyframe once');
  media._judge();
  assert.ok(media.bitrate.target < before, `bitrate came down (${before} → ${media.bitrate.target})`);
  // Drained again: only a keyframe restarts the picture.
  macSocket.bufferedAmount = 0;
  media.pushVideo(frame(false));
  assert.equal(media.totals.videoFrames, 2, 'a delta frame after a drop is skipped');
  media.pushVideo(frame(true));
  assert.equal(media.totals.videoFrames, 3);
  const s = media.sample();
  assert.equal(typeof s.kbps, 'number');
  assert.equal(s.link, media.bitrate.link);
  media.stop();
  peer.close();
});

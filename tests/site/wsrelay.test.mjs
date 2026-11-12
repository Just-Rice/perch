// The Worker relay's shared pieces (site/js/shared/wsrelay.js): the offer and its signature and pin, the keys, and the
// encrypted framing that must refuse anything replayed, reordered or changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { X509Certificate, sign, createHash } from 'node:crypto';
import * as W from '../../site/js/shared/wsrelay.js';
import { looksBlocked } from '../../site/js/ui/connection.js';
import { codecFromAnnexB } from '../../site/js/ui/relaymedia.js';
import { bindingHash } from '../../site/js/shared/bind.js';

const werift = createRequire(new URL('../../host/node/package.json', import.meta.url))('werift');

const sid = 'S'.repeat(22);
const room = 'R'.repeat(22);
const url = 'https://perch-relay.someone.workers.dev';

async function macCert() {
  const keys = await werift.createSelfSignedCertificate(
    { signature: werift.SignatureAlgorithm.ecdsa_3, hash: werift.HashAlgorithm.sha256_4 }, werift.NamedCurveAlgorithm.secp256r1_23);
  const der = new Uint8Array(new X509Certificate(keys.certPem).raw);
  return { keys, der, pin: new Uint8Array(createHash('sha256').update(der).digest().subarray(0, 16)) };
}

async function signedOffer(cert, eph, over = {}) {
  const fields = { sid, url, room, eph, ...over };
  const sig = sign('sha256', await W.offerSignedBytes(fields), { key: cert.keys.keyPem, dsaEncoding: 'ieee-p1363' });
  return W.makeOffer({ ...fields, cert: cert.der, sig: new Uint8Array(sig) });
}

test('relay addresses: workers.dev over https only (loopback only in tests)', () => {
  assert.equal(W.relayBase('https://perch-relay.someone.workers.dev/'), 'https://perch-relay.someone.workers.dev');
  assert.equal(W.relayBase('https://a.b.workers.dev'), 'https://a.b.workers.dev');
  for (const bad of ['http://perch-relay.someone.workers.dev', 'https://example.com', 'https://workers.dev',
    'https://x.workers.dev/path', 'https://x.workers.dev?q=1', 'https://u:p@x.workers.dev', 'https://x.workers.dev:8443',
    'https://x.workers.dev.evil.com', 'http://localhost:8787', 'not a url', '']) {
    assert.equal(W.relayBase(bad), null, bad);
  }
  assert.equal(W.relayBase('http://localhost:8787', { allowLocal: true }), 'http://localhost:8787');
  assert.equal(W.roomUrl('https://x.workers.dev', room, 'viewer'), `wss://x.workers.dev/v1/room/${room}?role=viewer`);
});

test('a signed offer is accepted with the right pin and refused with any other, or when changed', async () => {
  const cert = await macCert();
  const mac = await W.newEcdh();
  const offer = await signedOffer(cert, mac.pub);
  const got = await W.readOffer(offer, { sid, pin: cert.pin });
  assert.equal(got.room, room);
  assert.equal(got.url, url);
  await assert.rejects(W.readOffer(offer, { sid, pin: new Uint8Array(16) }), /another Mac/);
  await assert.rejects(W.readOffer(offer, { sid: 'X'.repeat(22), pin: cert.pin }), /another connection/);
  for (const change of [{ room: 'Q'.repeat(22) }, { url: 'https://evil.someone.workers.dev' }]) {
    const o = JSON.parse(offer);
    Object.assign(o, change);
    await assert.rejects(W.readOffer(JSON.stringify(o), { sid, pin: cert.pin }), /signature/, JSON.stringify(change));
  }
  // Another Mac's key, signed by another certificate, doesn't pass this Mac's pin.
  const stranger = await macCert();
  await assert.rejects(W.readOffer(await signedOffer(stranger, mac.pub), { sid, pin: cert.pin }), /another Mac/);
  // With a pin, an unsigned offer is refused; without one (backup sign-in) it is read, and the binding protects it.
  const unsigned = W.makeOffer({ sid, url, room, eph: mac.pub });
  await assert.rejects(W.readOffer(unsigned, { sid, pin: cert.pin }), /not signed/);
  assert.equal((await W.readOffer(unsigned, { sid })).room, room);
  // Addresses the website's CSP would block anyway are refused up front.
  const local = W.makeOffer({ sid, url: 'http://localhost:8787', room, eph: mac.pub });
  await assert.rejects(W.readOffer(local, { sid }), /address/);
  assert.equal((await W.readOffer(local, { sid, allowLocal: true })).url, 'http://localhost:8787');
});

async function pair() {
  const mac = await W.newEcdh();
  const viewer = await W.newEcdh();
  const offer = W.makeOffer({ sid, url, room, eph: mac.pub });
  const answer = W.makeAnswer({ sid, eph: viewer.pub });
  return {
    offer, answer,
    mac: await W.sessionKeys(mac.privateKey, W.readAnswer(answer, { sid }).eph, offer, answer, 'mac'),
    viewer: await W.sessionKeys(viewer.privateKey, mac.pub, offer, answer, 'viewer'),
  };
}

function link(sendKeys, recvKeys) {
  const got = [];
  const errors = [];
  const wire = [];
  const rx = new W.Channel({ keys: recvKeys, out: () => {}, deliver: (type, p) => got.push([type, p]), onError: e => errors.push(e.message) });
  const tx = new W.Channel({ keys: sendKeys, out: m => wire.push(m), deliver: () => {} });
  return { rx, tx, got, errors, wire };
}

test('messages arrive whole and in order, big frames split and put back together', async () => {
  const k = await pair();
  const { rx, tx, got, errors, wire } = link(k.mac, k.viewer);
  const frame = new Uint8Array(W.CHUNK * 2 + 1234).map((_, i) => i & 0xff);
  tx.send(W.T.CONTROL, '{"t":"hi"}');
  tx.send(W.T.VIDEO, W.videoPayload({ keyframe: true, ptsUs: 5e9, data: frame }));
  tx.send(W.T.AUDIO, W.audioPayload([{ ptsUs: 1, data: new Uint8Array(80) }, { ptsUs: 21000, data: new Uint8Array(90).fill(9) }]));
  await tx.sending;
  assert.equal(wire.length, 1 + 3 + 1, 'the frame went as three pieces');
  for (const m of wire) assert.ok(m.length <= W.MAX_MESSAGE + 8 + 16, 'each piece fits a relay message');
  for (const m of wire) rx.open(m);
  await rx.receiving;
  assert.deepEqual(errors, []);
  assert.deepEqual(got.map(g => g[0]), [W.T.CONTROL, W.T.VIDEO, W.T.AUDIO]);
  assert.equal(W.fromUtf8(got[0][1]), '{"t":"hi"}');
  const v = W.readVideo(got[1][1]);
  assert.equal(v.keyframe, true);
  assert.equal(v.ptsUs, 5e9);
  assert.deepEqual(v.data, frame);
  const a = W.readAudio(got[2][1]);
  assert.deepEqual(a.map(p => [p.ptsUs, p.data.length, p.data[0]]), [[1, 80, 0], [21000, 90, 9]]);
});

test('a replayed, reordered, changed or wrongly keyed message ends the channel', async () => {
  const k = await pair();
  const send = async () => {
    const l = link(k.mac, k.viewer);
    l.tx.send(W.T.CONTROL, 'one');
    l.tx.send(W.T.CONTROL, 'two');
    await l.tx.sending;
    return l;
  };
  const settle = l => l.rx.receiving.then(() => new Promise(r => setTimeout(r, 10)));

  let l = await send();
  l.rx.open(l.wire[0]); l.rx.open(l.wire[0]); l.rx.open(l.wire[1]);
  await settle(l);
  assert.deepEqual(l.got.map(g => W.fromUtf8(g[1])), ['one'], 'replay: only the first copy, then nothing');
  assert.match(l.errors[0], /out of order/);

  l = await send();
  l.rx.open(l.wire[1]);
  await settle(l);
  assert.equal(l.got.length, 0, 'reordered');

  l = await send();
  const bad = l.wire[0].slice();
  bad[bad.length - 1] ^= 1;
  l.rx.open(bad);
  await settle(l);
  assert.equal(l.got.length, 0, 'changed');
  assert.equal(l.errors.length, 1);

  // The viewer's own messages can't be reflected back to it as if the Mac sent them: each direction has its own key.
  const back = link(k.viewer, k.viewer);
  back.tx.send(W.T.CONTROL, 'echo');
  await back.tx.sending;
  back.rx.open(back.wire[0]);
  await settle(back);
  assert.equal(back.got.length, 0, 'reflected');
});

test('a key swapped in the middle gives the two sides different keys and different bindings', async () => {
  const mac = await W.newEcdh(), viewer = await W.newEcdh(), mallory = await W.newEcdh();
  const offer = W.makeOffer({ sid, url, room, eph: mac.pub });
  const realAnswer = W.makeAnswer({ sid, eph: viewer.pub });
  const swapped = W.makeAnswer({ sid, eph: mallory.pub });
  const nonce = new Uint8Array(32).fill(1);
  assert.notDeepEqual(await bindingHash(nonce, offer, realAnswer), await bindingHash(nonce, offer, swapped));
  const atMac = await W.sessionKeys(mac.privateKey, mallory.pub, offer, swapped, 'mac');
  const atViewer = await W.sessionKeys(viewer.privateKey, mac.pub, offer, realAnswer, 'viewer');
  const l = link(atMac, atViewer);
  l.tx.send(W.T.CONTROL, 'secret');
  await l.tx.sending;
  l.rx.open(l.wire[0]);
  await l.rx.receiving;
  assert.equal(l.got.length, 0, 'the viewer can’t read what the Mac sealed for someone else');
});

test('the owner proof the relay checks', async () => {
  const secret = 'ab'.repeat(32);
  assert.match(await W.roomAuth(secret, room), /^[0-9a-f]{64}$/);
  assert.notEqual(await W.roomAuth(secret, room), await W.roomAuth(secret, 'Q'.repeat(22)));
  assert.notEqual(await W.roomAuth(secret, room), await W.checkAuth(secret));
});

test('a network that blocks WebRTC: no public or relay candidate though STUN was asked', () => {
  const host = 'a=candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host generation 0\r\n';
  const srflx = 'a=candidate:2 1 udp 1686052607 203.0.113.9 54321 typ srflx raddr 192.168.1.5 rport 54321\r\n';
  const relay = 'a=candidate:3 1 udp 41885439 198.51.100.1 3478 typ relay raddr 0.0.0.0 rport 0\r\n';
  const stun = [{ urls: 'stun:stun.example.com' }];
  assert.equal(looksBlocked(`v=0\r\n${host}`, stun), true);
  assert.equal(looksBlocked(`v=0\r\n${host}${srflx}`, stun), false);
  assert.equal(looksBlocked(`v=0\r\n${host}${relay}`, stun), false);
  assert.equal(looksBlocked(`v=0\r\n${host}`, []), false, 'without STUN servers (tests) nothing is concluded');
});

test('the H.264 codec string comes from the SPS', () => {
  const au = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x28, 0xff, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 1, 0x65, 0x88]);
  assert.equal(codecFromAnnexB(au), 'avc1.42e028');
  assert.equal(codecFromAnnexB(Uint8Array.from([0, 0, 1, 0x41, 0x9a])), null, 'a delta frame has no SPS');
});

test('the relay as a rendezvous broker, and the relay address a remembered Mac keeps', async () => {
  assert.equal(W.relayBroker('https://perch-relay.someone.workers.dev'), 'wss://perch-relay.someone.workers.dev/v1/mqtt');
  assert.equal(W.relayBroker('http://localhost:8787'), 'ws://localhost:8787/v1/mqtt');
  const { MacStore } = await import('../../site/js/ui/macs.js');
  const mem = new Map();
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  const store = new MacStore(storage);
  const mac = { hostId: 'A'.repeat(22), sigKey: 'B'.repeat(43), credentialId: 'cred', name: 'test' };
  assert.equal(store.save({ ...mac, relay: 'https://perch-relay.someone.workers.dev' }).relay, 'https://perch-relay.someone.workers.dev');
  assert.equal(store.update(mac.hostId, { relay: 'https://evil.example.com' }).relay, undefined, 'only a relay address is kept');
  assert.equal(store.update(mac.hostId, { relay: 'https://perch-relay.someone.workers.dev' }).relay, 'https://perch-relay.someone.workers.dev');
  assert.equal(store.update(mac.hostId, { relay: undefined }).relay, undefined, 'a Mac without one any more clears it');
});

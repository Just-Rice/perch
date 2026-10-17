// Tests for the code shared by the website and the host (site/js/shared). Run: node --test host/node/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { toB64url, fromB64url, randomBytes, equalBytes, utf8 } from '../../../site/js/shared/bytes.js';
import { bindingHash, bindProof } from '../../../site/js/shared/bind.js';
import { MqttClient } from '../../../site/js/shared/mqtt.js';
import {
  seal, open, hostTopic, nameTopic, hostEnvelopeKey, nameEnvelopeKey, normalizeMacName, MAC_NAME_RE, Rendezvous,
} from '../../../site/js/shared/rendezvous.js';

test('base64url round-trips every length and rejects junk', () => {
  for (let n = 0; n < 70; n++) {
    const b = randomBytes(n);
    assert.ok(equalBytes(fromB64url(toB64url(b)), b));
    assert.doesNotMatch(toB64url(b), /[+/=]/);
  }
  assert.throws(() => fromB64url('ab+c'));
  assert.throws(() => fromB64url(42));
});

test('equalBytes compares content and length', () => {
  assert.equal(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2)), true);
  assert.equal(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3)), false);
  assert.equal(equalBytes(Uint8Array.of(1), Uint8Array.of(1, 0)), false);
});

test('envelopes open only with the right key, topic and freshness', async () => {
  const topic = await hostTopic(randomBytes(16));
  const key = await hostEnvelopeKey(randomBytes(32));
  const other = await hostEnvelopeKey(randomBytes(32));
  const env = await seal(key, topic, { t: 'hello', sid: 'abc' }, 1_000_000);
  const ok = await open(key, topic, env, 1_000_000);
  assert.equal(ok.msg.t, 'hello');
  assert.equal(ok.msg.sid, 'abc');
  assert.equal(await open(other, topic, env, 1_000_000), null, 'wrong key');
  assert.equal(await open(key, topic + '/x', env, 1_000_000), null, 'moved to another topic');
  assert.equal(await open(key, topic, env, 1_000_000 + 6 * 60_000), null, 'too old');
  assert.equal(await open(key, topic, env, 1_000_000 - 6 * 60_000), null, 'from the future');
  const tampered = JSON.parse(env);
  tampered.c = tampered.c.slice(0, -2) + (tampered.c.endsWith('A') ? 'B' : 'A') + tampered.c.slice(-1);
  assert.equal(await open(key, topic, JSON.stringify(tampered), 1_000_000), null, 'tampered');
  assert.equal(await open(key, topic, 'not json', 1_000_000), null);
  assert.equal(await open(key, topic, 'x'.repeat(70_000), 1_000_000), null, 'oversized');
});

test('topics are stable, distinct and do not reveal the input', async () => {
  const id = randomBytes(16);
  assert.equal(await hostTopic(id), await hostTopic(id));
  assert.notEqual(await hostTopic(id), await hostTopic(randomBytes(16)));
  assert.match(await hostTopic(id), /^perch\/v1\/h\/[A-Za-z0-9_-]{22}$/);
  assert.equal(await nameTopic('Amber-Otter-4821 '), await nameTopic('amber-otter-4821'));
  assert.ok(!(await nameTopic('amber-otter-4821')).includes('amber'));
  assert.equal(normalizeMacName('  Amber Otter 4821 '), 'amber-otter-4821');
  assert.match('amber-otter-4821', MAC_NAME_RE);
  assert.doesNotMatch('amber-otter', MAC_NAME_RE);
  const k1 = await nameEnvelopeKey('amber-otter-4821');
  const env = await seal(k1, 't', { t: 'x' });
  assert.ok(await open(await nameEnvelopeKey('Amber-Otter-4821'), 't', env));
});

test('binding changes if either SDP or the nonce changes', async () => {
  const nonce = randomBytes(32);
  const a = await bindingHash(nonce, 'offer', 'answer');
  assert.equal(a.length, 32);
  assert.ok(equalBytes(a, await bindingHash(nonce, 'offer', 'answer')));
  assert.ok(!equalBytes(a, await bindingHash(nonce, 'offer ', 'answer')));
  assert.ok(!equalBytes(a, await bindingHash(nonce, 'offer', 'answer\r\n')));
  assert.ok(!equalBytes(a, await bindingHash(randomBytes(32), 'offer', 'answer')));
  // Swapping the two SDPs must not give the same value.
  assert.ok(!equalBytes(a, await bindingHash(nonce, 'answer', 'offer')));
  await assert.rejects(bindingHash(randomBytes(16), 'o', 'a'));
  const key = randomBytes(32);
  const p = await bindProof(key, 'pair', a);
  assert.ok(equalBytes(p, await bindProof(key, 'pair', a)));
  assert.ok(!equalBytes(p, await bindProof(key, 'backup', a)), 'labels keep purposes apart');
});

// A fake WebSocket that behaves like a broker and deliberately splits and merges MQTT packets.
class FakeBroker {
  constructor() { this.sockets = new Set(); this.subs = new Map(); }
  socketClass() {
    const broker = this;
    return class FakeSocket {
      constructor(url, protocols) {
        assert.deepEqual(protocols, ['mqtt']);
        this.readyState = 0;
        this.pending = new Uint8Array(0);
        broker.sockets.add(this);
        setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1);
      }
      send(bytes) { broker.receive(this, bytes); }
      close() { this.readyState = 3; broker.sockets.delete(this); }
      deliver(bytes) {
        // Split into odd-sized chunks, sometimes merged with the previous remainder.
        let o = 0;
        while (o < bytes.length) {
          const n = Math.min(bytes.length - o, 1 + Math.floor(Math.random() * 7));
          const chunk = bytes.slice(o, o + n);
          o += n;
          setTimeout(() => this.onmessage?.({ data: chunk.buffer }), 0);
        }
      }
    };
  }
  receive(sock, bytes) {
    const type = bytes[0] >> 4;
    let i = 1, len = 0, mult = 1, b;
    do { b = bytes[i++]; len += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
    const p = bytes.subarray(i, i + len);
    if (type === 1) sock.deliver(Uint8Array.of(0x20, 2, 0, 0));
    else if (type === 8) {
      const tl = (p[2] << 8) | p[3];
      const topic = new TextDecoder().decode(p.subarray(4, 4 + tl));
      if (!this.subs.has(topic)) this.subs.set(topic, new Set());
      this.subs.get(topic).add(sock);
      sock.deliver(Uint8Array.of(0x90, 3, p[0], p[1], 0));
    } else if (type === 3) {
      const tl = (p[0] << 8) | p[1];
      const topic = new TextDecoder().decode(p.subarray(2, 2 + tl));
      for (const s of this.subs.get(topic) ?? []) s.deliver(bytes.slice());
    } else if (type === 12) sock.deliver(Uint8Array.of(0xd0, 0));
  }
}

test('MQTT client reassembles split packets and delivers large payloads', async () => {
  const broker = new FakeBroker();
  const WS = broker.socketClass();
  const a = new MqttClient('wss://fake/a', { WebSocketImpl: WS });
  const b = new MqttClient('wss://fake/b', { WebSocketImpl: WS });
  await a.connect();
  await b.connect();
  const got = [];
  b.onmessage = (topic, payload) => got.push([topic, payload.length, payload[payload.length - 1]]);
  await b.subscribe('perch/v1/test');
  const big = new Uint8Array(200_000).fill(7);
  big[big.length - 1] = 9;
  a.publish('perch/v1/test', big);
  a.publish('perch/v1/test', 'hi');
  for (let i = 0; i < 200 && got.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(got, [['perch/v1/test', 200_000, 9], ['perch/v1/test', 2, 105]]);
  a.close();
  b.close();
});

test('Rendezvous de-duplicates the same message arriving from several brokers', async () => {
  const broker = new FakeBroker();
  const WS = broker.socketClass();
  const urls = ['wss://fake/1', 'wss://fake/2', 'wss://fake/3'];
  const a = new Rendezvous({ brokers: urls, WebSocketImpl: WS });
  const b = new Rendezvous({ brokers: urls, WebSocketImpl: WS });
  await a.start();
  await b.start();
  for (let i = 0; i < 100 && (a.connectedCount < 3 || b.connectedCount < 3); i++) await new Promise(r => setTimeout(r, 10));
  const topic = await hostTopic(randomBytes(16));
  const key = await hostEnvelopeKey(randomBytes(32));
  const got = [];
  await b.listen(topic, key, m => got.push(m));
  assert.equal(await a.send(topic, key, { t: 'hello', sid: 's' }), 3);
  for (let i = 0; i < 100 && got.length < 1; i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(got.length, 1);
  assert.equal(got[0].t, 'hello');
  a.close();
  b.close();
});

test('utf8 helper encodes non-ASCII text', () => {
  assert.deepEqual([...utf8('é')], [0xc3, 0xa9]);
});

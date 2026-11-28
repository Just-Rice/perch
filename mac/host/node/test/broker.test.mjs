// The local test broker must behave like the public ones for Perch's client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBroker } from '../../../tests/e2e/broker.mjs';
import { Rendezvous, hostTopic, hostEnvelopeKey } from '../../../site/js/shared/rendezvous.js';
import { randomBytes } from '../../../site/js/shared/bytes.js';

test('local broker carries rendezvous messages between two clients', async () => {
  const broker = await startBroker();
  const a = new Rendezvous({ brokers: [broker.url] });
  const b = new Rendezvous({ brokers: [broker.url] });
  await a.start();
  await b.start();
  const topic = await hostTopic(randomBytes(16));
  const key = await hostEnvelopeKey(randomBytes(32));
  const got = [];
  await b.listen(topic, key, m => got.push(m));
  await a.send(topic, key, { t: 'hello', sid: 'x', pad: 'y'.repeat(20000) });
  for (let i = 0; i < 100 && !got.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(got.length, 1);
  assert.equal(got[0].pad.length, 20000);
  a.close();
  b.close();
  await broker.close();
});

test('a broker added while running (the owner’s relay) carries messages to topics already listened to', async () => {
  const first = await startBroker();
  const second = await startBroker();
  const mac = new Rendezvous({ brokers: [first.url] });
  const viewer = new Rendezvous({ brokers: [second.url] }); // only reaches the second broker
  await mac.start();
  await viewer.start();
  const topic = await hostTopic(randomBytes(16));
  const key = await hostEnvelopeKey(randomBytes(32));
  const got = [];
  await mac.listen(topic, key, m => got.push(m));
  await viewer.send(topic, key, { t: 'hello', sid: 'before' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(got.length, 0, 'no broker in common yet');

  mac.addBroker(second.url);
  mac.addBroker(second.url); // twice is once
  assert.equal(mac.brokers.length, 2);
  for (let i = 0; i < 100 && mac.connectedCount < 2; i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 100)); // the subscription follows the connection
  await viewer.send(topic, key, { t: 'hello', sid: 'after' });
  for (let i = 0; i < 100 && !got.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(got.map(m => m.sid), ['after'], 'listened to on the new broker straight away');

  mac.removeBroker(second.url);
  assert.deepEqual(mac.status().map(s => s.url), [first.url]);
  await viewer.send(topic, key, { t: 'hello', sid: 'gone' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(got.length, 1, 'nothing after the broker was taken away');

  // Before start(), adding only extends the list that start() dials.
  const later = new Rendezvous({ brokers: [first.url] });
  later.addBroker(second.url);
  assert.equal(later.clients.size, 0);
  await later.start();
  for (let i = 0; i < 100 && later.connectedCount < 2; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(later.connectedCount, 2);
  later.close();
  mac.close();
  viewer.close();
  await first.close();
  await second.close();
});

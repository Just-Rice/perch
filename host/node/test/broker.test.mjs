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

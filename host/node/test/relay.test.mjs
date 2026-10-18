// The optional relay: asking Cloudflare for TURN logins, checking a key before saving it, caching, and the checker
// both sides run on relay settings (site/js/shared/relay.js). Cloudflare itself is replaced by a stand-in fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Relay } from '../src/relay.mjs';
import { cleanIceServers, hasRelay } from '../../../site/js/shared/relay.js';

const KEY = { keyId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', apiToken: 'tok_' + 'x'.repeat(60) };
const CLOUDFLARE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u1', credential: 'c1' },
  ],
};

function fakeCloudflare({ status = 201, body = CLOUDFLARE, fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (fail) throw new Error('offline');
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

const store = async () => Store.open({ home: mkdtempSync(join(tmpdir(), 'perch-relay-')), secrets: 'file' });

test('saving a key checks it with Cloudflare first, keeps the token secret, and hands out relay logins', async () => {
  const s = await store();
  const cf = fakeCloudflare();
  const r = new Relay({ store: s, fetchImpl: cf.fetchImpl });
  assert.deepEqual(await r.iceServers(), [], 'no relay until one is set up');
  await r.save(` ${KEY.keyId} `, KEY.apiToken);
  assert.equal(cf.calls.length, 1);
  assert.equal(cf.calls[0].url, `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY.keyId}/credentials/generate-ice-servers`);
  assert.equal(cf.calls[0].opts.method, 'POST');
  assert.equal(cf.calls[0].opts.headers.Authorization, `Bearer ${KEY.apiToken}`);
  assert.deepEqual(JSON.parse(cf.calls[0].opts.body), { ttl: 86400 });
  assert.equal(s.config.relay.set, true);
  assert.ok(!JSON.stringify(s.config).includes(KEY.apiToken), 'the token is not in config.json');
  const list = await r.iceServers();
  assert.equal(cf.calls.length, 1, 'cached: no second request');
  assert.deepEqual(list, [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp',
    'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u1', credential: 'c1' }],
    'relay entries only, port 53 dropped');
  assert.deepEqual(r.state(), { set: true, setAt: s.config.relay.setAt, working: true, error: null });
  await r.remove();
  assert.equal(s.relayLogin, null);
  assert.deepEqual(await r.iceServers(), []);
});

test('a wrong key, an outage or a strange answer is refused with a plain message', async () => {
  const s = await store();
  await assert.rejects(new Relay({ store: s, fetchImpl: fakeCloudflare({ status: 401 }).fetchImpl }).save(KEY.keyId, KEY.apiToken),
    /didn’t accept that relay key/);
  await assert.rejects(new Relay({ store: s, fetchImpl: fakeCloudflare({ fail: true }).fetchImpl }).save(KEY.keyId, KEY.apiToken),
    /couldn’t reach Cloudflare/);
  await assert.rejects(new Relay({ store: s, fetchImpl: fakeCloudflare({ body: { iceServers: [{ urls: ['stun:x:3478'] }] } }).fetchImpl })
    .save(KEY.keyId, KEY.apiToken), /didn’t include a relay/);
  await assert.rejects(new Relay({ store: s, fetchImpl: fakeCloudflare().fetchImpl }).save('bad id!', KEY.apiToken), /Turn Token ID/);
  await assert.rejects(new Relay({ store: s, fetchImpl: fakeCloudflare().fetchImpl }).save(KEY.keyId, 'short'), /API token/);
  assert.equal(s.relayLogin, null, 'nothing saved');
});

test('when Cloudflare is down at connection time, the connection goes ahead without a relay', async () => {
  const s = await store();
  const good = fakeCloudflare();
  let clock = 1_000_000;
  const r = new Relay({ store: s, fetchImpl: good.fetchImpl, now: () => clock });
  await r.save(KEY.keyId, KEY.apiToken);
  // The cached logins are handed out until they have only 12 hours left, then fetched again.
  clock += 11 * 3600e3;
  await r.iceServers();
  assert.equal(good.calls.length, 1);
  clock += 2 * 3600e3;
  r.fetchImpl = fakeCloudflare({ fail: true }).fetchImpl;
  assert.deepEqual(await r.iceServers(), []);
  assert.equal(r.state().working, false);
  assert.match(r.state().error, /couldn’t reach Cloudflare/);
});

test('the shared checker only lets plain STUN/TURN entries through', () => {
  assert.deepEqual(cleanIceServers([{ urls: 'turn:a.example:3478', username: 'u', credential: 'c' }]),
    [{ urls: ['turn:a.example:3478'], username: 'u', credential: 'c' }]);
  assert.deepEqual(cleanIceServers([{ urls: 'turn:a.example:3478' }]), [], 'TURN without a login');
  assert.deepEqual(cleanIceServers([{ urls: ['javascript:alert(1)', 'http://x'] }]), []);
  assert.deepEqual(cleanIceServers([{ urls: 'stun:a.example:53' }]), [], 'port 53');
  assert.deepEqual(cleanIceServers('nope'), []);
  assert.equal(cleanIceServers(Array(10).fill({ urls: 'stun:a.example:3478' })).length, 4, 'at most four entries');
  assert.equal(hasRelay([{ urls: 'stun:a.example:3478' }]), false);
  assert.equal(hasRelay(CLOUDFLARE.iceServers), true);
});

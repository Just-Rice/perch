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
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../../../relay-service/src/handler.js';
import { LedgerCore, DEFAULT_LIMITS, GB } from '../../../relay-service/src/ledger.js';

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
  const { shared, ...own } = r.state();
  assert.deepEqual(own, { set: true, setAt: s.config.relay.setAt, working: true, error: null });
  assert.deepEqual([shared.available, shared.using], [false, false], 'no shared service in this test');
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
  // Logins are reused for 6 hours, then renewed in the background while the old ones are still handed out.
  clock += 5 * 3600e3;
  await r.iceServers();
  assert.equal(good.calls.length, 1);
  clock += 2 * 3600e3;
  assert.equal((await r.iceServers()).length, 1, 'the old logins, at once');
  await r.refreshing;
  assert.equal(good.calls.length, 2, 'renewed in the background');
  // Cloudflare down once the logins have under 12 hours left: the connection goes ahead without a relay.
  clock += 13 * 3600e3;
  r.fetchImpl = fakeCloudflare({ fail: true }).fetchImpl;
  assert.deepEqual(await r.iceServers(), []);
  assert.equal(r.state().working, false);
  assert.match(r.state().error, /couldn’t reach Cloudflare/);
});

test('a slow Cloudflare never holds an offer up: no relay this time, logins ready for the next', async () => {
  const s = await store();
  await new Relay({ store: s, fetchImpl: fakeCloudflare().fetchImpl }).save(KEY.keyId, KEY.apiToken);
  let release;
  const slow = { calls: 0 };
  const r = new Relay({ store: s, fetchImpl: async () => {
    slow.calls++;
    await new Promise(resolve => { release = resolve; });
    return { ok: true, status: 201, json: async () => CLOUDFLARE };
  } });
  const t0 = Date.now();
  assert.deepEqual(await r.iceServers({ waitMs: 50 }), []);
  assert.ok(Date.now() - t0 < 1000);
  release();
  await r.refreshing;
  assert.equal((await r.iceServers({ waitMs: 50 })).length, 1);
  assert.equal(slow.calls, 1);
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

// --- Perch's shared relay service: the real service code (handler and ledger) stands in for the network ---

function sharedService({ ownerKey = 'owner-key-for-the-host-tests-0123' } = {}) {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(q, ...p) { const st = db.prepare(q); const rows = /^\s*SELECT/i.test(q) ? st.all(...p) : (st.run(...p), []); return { toArray: () => rows }; } };
  const svc = { minted: [], revoked: [], usage: {}, requests: [] };
  const turn = {
    async mint({ ttl, customIdentifier }) {
      const username = `s${svc.minted.length + 1}`;
      svc.minted.push({ username, ttl, customIdentifier });
      return { username, iceServers: [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username, credential: 'pw' }] };
    },
    async revoke(u) { svc.revoked.push(u); },
    async usage({ to }) {
      const byMac = { [to]: { ...svc.usage } };
      return { total: { [to]: Object.values(svc.usage).reduce((a, b) => a + b, 0) }, byMac };
    },
  };
  svc.ledger = new LedgerCore({ sql, turn, limits: DEFAULT_LIMITS });
  svc.fetchImpl = async (url, opts) => {
    svc.requests.push({ url, body: JSON.parse(opts.body) });
    return handle(new Request(url, { method: opts.method, body: opts.body, headers: opts.headers }), { OWNER_KEY: ownerKey }, svc.ledger);
  };
  svc.ownerKey = ownerKey;
  return svc;
}

test('shared relay: used when there is no key of your own, signed with this Mac’s own relay key', async () => {
  const s = await store();
  const svc = sharedService();
  const r = new Relay({ store: s, fetchImpl: svc.fetchImpl, serviceUrl: 'https://relay.example/' });
  const list = await r.iceServers();
  assert.deepEqual(list, [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 's1', credential: 'pw' }]);
  assert.equal(svc.requests[0].url, 'https://relay.example/v1/ice');
  assert.equal(svc.minted[0].ttl, 3 * 3600, 'somebody else’s Mac as far as the service knows');
  assert.ok(s.relayIdentity?.pub, 'a relay key was made and kept with the secrets');
  assert.ok(!JSON.stringify(s.config).includes(s.relayIdentity.pkcs8), 'not in config.json');
  const st = r.state().shared;
  assert.deepEqual([st.available, st.on, st.using, st.owner, st.working], [true, true, true, false, true]);
  assert.deepEqual([st.usage.macBytes, st.usage.macLimitBytes], [0, 20 * GB]);
  // The same key next time: the service sees the same Mac.
  const again = new Relay({ store: s, fetchImpl: svc.fetchImpl, serviceUrl: 'https://relay.example' });
  await again.iceServers();
  assert.equal(svc.minted[1].customIdentifier, svc.minted[0].customIdentifier);
  // A key of your own wins; switching the shared relay off means no relay at all.
  s.updateSettings({ sharedRelay: false });
  const off = new Relay({ store: s, fetchImpl: svc.fetchImpl, serviceUrl: 'https://relay.example' });
  assert.deepEqual(await off.iceServers(), []);
  assert.equal(off.state().shared.using, false);
});

test('shared relay: over the limit, the Mac stops handing out its old logins and says why', async () => {
  const s = await store();
  const svc = sharedService();
  let t = Date.now(); // the service checks the Mac's clock against its own
  const r = new Relay({ store: s, fetchImpl: svc.fetchImpl, serviceUrl: 'https://relay.example', now: () => t });
  assert.equal((await r.iceServers()).length, 1);
  svc.usage[svc.minted[0].customIdentifier] = 21 * GB;
  await svc.ledger.refresh();
  assert.deepEqual(svc.revoked, ['s1']);
  r.cache.refreshAt = t; // as if 45 minutes had passed: the next offer fetches again, in the background
  await r.iceServers();
  await r.refreshing;
  assert.deepEqual(await r.iceServers({ waitMs: 50 }), [], 'the revoked login is not handed out again');
  const st = r.state().shared;
  assert.equal(st.working, false);
  assert.match(st.error, /used its share/);
  assert.ok(st.usage.macBytes >= 20 * GB);
});

test('shared relay: the owner key is checked with the service, and lifts this Mac’s limit', async () => {
  const s = await store();
  const svc = sharedService();
  const r = new Relay({ store: s, fetchImpl: svc.fetchImpl, serviceUrl: 'https://relay.example' });
  await assert.rejects(r.saveOwnerKey('short'), /doesn’t look right/);
  await assert.rejects(r.saveOwnerKey('a-wrong-owner-key-0123456789'), /didn’t accept that owner key/);
  assert.equal(s.relayOwnerKey, null, 'a key the service turned down is not kept');
  await r.saveOwnerKey(` ${svc.ownerKey} `);
  assert.equal(s.relayOwnerKey, svc.ownerKey);
  assert.ok(!JSON.stringify(s.config).includes(svc.ownerKey), 'the owner key is kept with the secrets');
  assert.ok(!JSON.stringify(svc.requests.at(-1).body).includes(svc.ownerKey), 'and never sent');
  assert.equal(svc.minted.at(-1).ttl, 24 * 3600);
  svc.usage[svc.minted.at(-1).customIdentifier] = 150 * GB;
  await svc.ledger.refresh();
  r.forget();
  assert.equal((await r.iceServers()).length, 1, '150 GB is fine on the owner’s Mac');
  const st = r.state().shared;
  assert.deepEqual([st.owner, st.usage.owner, st.usage.macLimitBytes, st.usage.totalLimitBytes], [true, true, null, 990 * GB]);
  await r.removeOwnerKey();
  assert.equal(s.relayOwnerKey, null);
});

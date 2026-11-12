// The relay service end to end in Node: requests signed like a Mac signs them, the real handler and ledger, SQLite for
// storage, and a pretend Cloudflare (logins, revokes and usage numbers) behind the real API code.
//   node --test relay-service/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handle, identOf } from '../src/handler.js';
import { LedgerCore, limitsFrom, GB, HARD_TOTAL_GB } from '../src/ledger.js';
import { TurnApi, USAGE_QUERY } from '../src/turn.js';
import { requestText, ownerText } from '../src/request.js';
import { toB64url } from '../../site/js/shared/bytes.js';

const enc = new TextEncoder();
const OWNER_KEY = 'owner-key-for-tests-0123456789abcdef';
const DAY = 86400e3;

// SQLite with the same exec(...).toArray() shape as a Durable Object's storage.sql.
function sqlite() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(q, ...p) {
      const st = db.prepare(q);
      const rows = /^\s*(SELECT|WITH)/i.test(q) ? st.all(...p) : (st.run(...p), []);
      return { toArray: () => rows };
    },
  };
}

// Pretend Cloudflare: makes logins, revokes them, and reports usage that the test sets per Mac and per hour.
function fakeCloudflare() {
  const cf = { minted: [], revoked: [], usage: [], other: [], analyticsDown: false, mintDown: false, queries: [] };
  cf.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    let m;
    if ((m = u.match(/\/v1\/turn\/keys\/([^/]+)\/credentials\/generate$/))) {
      assert.equal(opts.headers.Authorization, 'Bearer turn-token');
      if (cf.mintDown) return new Response('no', { status: 500 });
      const username = `u${cf.minted.length + 1}`;
      cf.minted.push({ username, ...body });
      // As Cloudflare answers: one object, with port 53 addresses that browsers can't use.
      return Response.json({ iceServers: { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp',
        'turns:turn.cloudflare.com:443?transport=tcp', 'stun:stun.cloudflare.com:3478'], username, credential: `c-${username}` } }, { status: 201 });
    }
    if ((m = u.match(/\/credentials\/([^/]+)\/revoke$/))) {
      cf.revoked.push(decodeURIComponent(m[1]));
      return new Response(null, { status: 204 });
    }
    if (u === 'https://api.cloudflare.com/client/v4/graphql') {
      assert.equal(opts.headers.Authorization, 'Bearer analytics-token');
      cf.queries.push(body.variables);
      if (cf.analyticsDown) return Response.json({ data: null, errors: [{ message: 'not available' }] });
      const { from, to } = body.variables;
      const inRange = r => r.hour.slice(0, 10) >= from && r.hour.slice(0, 10) <= to;
      const rows = cf.usage.filter(inRange);
      const byHour = new Map();
      for (const r of [...rows, ...cf.other.filter(inRange)]) byHour.set(r.hour, (byHour.get(r.hour) ?? 0) + r.bytes);
      return Response.json({ data: { viewer: { accounts: [{
        total: [...byHour].map(([hour, bytes]) => ({ dimensions: { datetimeHour: hour }, sum: { egressBytes: bytes } })),
        byMac: rows.map(r => ({ dimensions: { datetimeHour: r.hour, customIdentifier: r.ident }, sum: { egressBytes: r.bytes } })),
      }] } } });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return cf;
}

async function setup({ env = {}, start = Date.parse('2026-11-11T12:00:00Z') } = {}) {
  const clock = { t: start };
  const now = () => clock.t;
  const cf = fakeCloudflare();
  const turn = new TurnApi({ keyId: 'key123456', apiToken: 'turn-token', accountId: 'acct', analyticsToken: 'analytics-token', fetchImpl: cf.fetch });
  const ledger = new LedgerCore({ sql: sqlite(), turn, limits: limitsFrom(env), now });
  const fullEnv = { OWNER_KEY, ...env };
  const call = async (body, path = '/v1/ice', init = {}) => {
    const res = await handle(new Request(`https://relay.example${path}`, { method: 'POST', body: JSON.stringify(body), ...init }), fullEnv, ledger, now());
    return { status: res.status, ...(await res.json()) };
  };
  return { clock, cf, ledger, call, env: fullEnv };
}

// A Mac: its relay key, and requests signed the way host/node/src/relay.mjs signs them.
async function mac({ ownerKey = null } = {}) {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const id = toB64url(pub);
  return {
    id,
    ident: await identOf(pub),
    async request(ts, { owner = ownerKey } = {}) {
      let proof;
      if (owner) {
        const k = await crypto.subtle.importKey('raw', enc.encode(owner), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        proof = toB64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(ownerText(id)))));
      }
      const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, enc.encode(requestText({ mac: id, ts, owner: proof }))));
      return { v: 1, mac: id, ts, sig: toB64url(sig), ...(proof ? { owner: proof } : {}) };
    },
  };
}

const hour = (t, h = 0) => new Date(t - h * 3600e3).toISOString().slice(0, 13) + ':00:00Z';

test('a Mac gets a relay login tagged with its own name; the key and limits are checked', async () => {
  const s = await setup();
  const a = await mac();
  const r = await s.call(await a.request(s.clock.t));
  assert.equal(r.status, 200);
  assert.equal(r.ttl, 3 * 3600, 'other people’s Macs get 3-hour logins');
  assert.deepEqual(r.iceServers, [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
    username: 'u1', credential: 'c-u1' }], 'relay addresses only, never port 53');
  assert.deepEqual(s.cf.minted[0], { username: 'u1', ttl: 3 * 3600, customIdentifier: a.ident });
  assert.deepEqual([r.usage.macBytes, r.usage.macLimitBytes, r.usage.owner], [0, 20 * GB, undefined]);
  assert.equal(s.cf.queries.length, 1, 'the first request fetched usage numbers first');
});

test('requests that are not from the Mac they name are refused', async () => {
  const s = await setup();
  const a = await mac(), b = await mac();
  const good = await a.request(s.clock.t);
  assert.equal((await s.call({ ...good, mac: b.id })).status, 403, 'another Mac’s key');
  assert.equal((await s.call({ ...good, ts: good.ts + 1 })).status, 403, 'changed after signing');
  assert.equal((await s.call(await a.request(s.clock.t - 6 * 60e3))).status, 400, 'too old');
  assert.equal((await s.call({ ...good, v: 2 })).status, 400);
  assert.equal((await s.call({ ...good, mac: 'short' })).status, 400);
  assert.equal((await s.call('x'.repeat(5000))).status, 413);
  const wrongOwner = await a.request(s.clock.t, { owner: 'not-the-owner-key-at-all-000000' });
  const r = await s.call(wrongOwner);
  assert.equal(r.status, 200, 'a wrong owner key still gets a login...');
  assert.equal(r.ttl, 3 * 3600, '...but as somebody else’s Mac');
  assert.equal(s.cf.minted.length, 1, 'only that one login was made');
});

test('the owner’s Macs: no per-Mac limit, 24-hour logins, and everyone’s numbers', async () => {
  const s = await setup();
  const mine = await mac({ ownerKey: OWNER_KEY });
  s.cf.usage.push({ hour: hour(s.clock.t, 1), ident: mine.ident, bytes: 150 * GB });
  const r = await s.call(await mine.request(s.clock.t));
  assert.equal(r.status, 200, '150 GB is fine for the owner’s own Mac');
  assert.equal(r.ttl, 24 * 3600);
  assert.deepEqual([r.usage.owner, r.usage.macBytes, r.usage.macLimitBytes, r.usage.totalBytes, r.usage.totalLimitBytes],
    [true, 150 * GB, null, 150 * GB, 990 * GB]);
});

test('another person’s Mac stops at 20 GB in 31 days, and its live logins are revoked', async () => {
  const s = await setup();
  const a = await mac(), b = await mac();
  const first = await s.call(await a.request(s.clock.t));
  assert.equal(first.status, 200);
  await s.call(await b.request(s.clock.t));
  // 19.5 GB ten days ago, 0.6 GB in the last hour: over 20 together.
  s.cf.usage.push({ hour: hour(s.clock.t, 240), ident: a.ident, bytes: 19.5 * GB });
  // The ledger only reads the last two days from Cloudflare; older days come from what it stored back then.
  s.clock.t -= 240 * 3600e3;
  await s.ledger.refresh();
  s.clock.t += 240 * 3600e3;
  s.cf.usage.push({ hour: hour(s.clock.t, 0), ident: a.ident, bytes: 0.6 * GB });
  const { revoked } = await s.ledger.refresh();
  assert.equal(revoked, 1);
  assert.deepEqual(s.cf.revoked, ['u1'], 'only that Mac’s login');
  const again = await s.call(await a.request(s.clock.t));
  assert.deepEqual([again.status, again.reason], [403, 'mac']);
  assert.ok(again.usage.macBytes >= 20 * GB);
  assert.equal((await s.call(await b.request(s.clock.t))).status, 200, 'other Macs carry on');

  // 21 days later the old 19.5 GB has left the 31-day window.
  s.clock.t += 21 * DAY;
  assert.equal((await s.call(await a.request(s.clock.t))).status, 200);
});

test('everyone else together stops at 900 GB; the owner’s Macs keep the last 90', async () => {
  const s = await setup();
  const mine = await mac({ ownerKey: OWNER_KEY });
  const strangers = await Promise.all(Array.from({ length: 50 }, () => mac()));
  for (const m of strangers) s.cf.usage.push({ hour: hour(s.clock.t, 2), ident: m.ident, bytes: 18 * GB });
  await s.ledger.refresh();
  const fresh = await mac();
  const r = await s.call(await fresh.request(s.clock.t));
  assert.deepEqual([r.status, r.reason], [403, 'others']);
  assert.match(r.message, /other people/);
  assert.equal((await s.call(await mine.request(s.clock.t))).status, 200);
});

test('everything stops at 990 GB, the owner’s Macs included, and near the limit logins last an hour', async () => {
  const s = await setup();
  const mine = await mac({ ownerKey: OWNER_KEY });
  const other = await mac();
  // Usage with no Perch tag counts too (anything else on the account).
  s.cf.other.push({ hour: hour(s.clock.t, 3), bytes: 960 * GB });
  await s.ledger.refresh();
  const near = await s.call(await mine.request(s.clock.t));
  assert.deepEqual([near.status, near.ttl], [200, 3600], 'within 40 GB of the limit: one-hour logins');
  const otherLogin = await s.call(await other.request(s.clock.t));
  assert.deepEqual([otherLogin.status, otherLogin.ttl], [200, 3600]);
  s.cf.other.push({ hour: hour(s.clock.t, 0), bytes: 31 * GB });
  const { revoked } = await s.ledger.refresh();
  assert.equal(revoked, 2, 'every live login, the owner’s too');
  for (const m of [mine, other]) {
    const r = await s.call(await m.request(s.clock.t));
    assert.deepEqual([r.status, r.reason], [403, 'total']);
  }
});

test('the limits can be lowered but the total never goes above 990', () => {
  assert.equal(limitsFrom({ TOTAL_LIMIT_GB: '5000' }).totalLimitGB, HARD_TOTAL_GB);
  assert.deepEqual(['macLimitGB', 'othersLimitGB', 'totalLimitGB'].map(k => limitsFrom({ TOTAL_LIMIT_GB: '100', OTHERS_LIMIT_GB: '500', MAC_LIMIT_GB: '5' })[k]), [5, 100, 100]);
  assert.equal(limitsFrom({ MAC_LIMIT_GB: 'lots' }).macLimitGB, 20);
});

test('when usage can’t be read: nothing new for other people’s Macs, nothing revoked, the owner carries on', async () => {
  const s = await setup();
  const mine = await mac({ ownerKey: OWNER_KEY });
  const other = await mac();
  assert.equal((await s.call(await other.request(s.clock.t))).status, 200);
  s.cf.analyticsDown = true;
  s.clock.t += 31 * 60e3;
  const { revoked } = await s.ledger.refresh();
  assert.equal(revoked, 0);
  const r = await s.call(await other.request(s.clock.t));
  assert.deepEqual([r.status, r.reason], [403, 'unknown']);
  assert.equal((await s.call(await mine.request(s.clock.t))).status, 200, 'last known total was far from the limit');
  // A brand-new service that has never read any numbers gives nobody a login.
  const t = await setup();
  t.cf.analyticsDown = true;
  assert.equal((await t.call(await (await mac({ ownerKey: OWNER_KEY })).request(t.clock.t))).reason, 'unknown');
  s.cf.analyticsDown = false;
  s.clock.t += 5 * 60e3;
  await s.ledger.refresh();
  assert.equal((await s.call(await other.request(s.clock.t))).status, 200, 'back once the numbers are back');
});

test('too many requests from one Mac are turned away; Cloudflare refusing a login is reported', async () => {
  const s = await setup();
  const a = await mac();
  for (let i = 0; i < 20; i++) assert.equal((await s.call(await a.request(s.clock.t))).status, 200);
  const r = await s.call(await a.request(s.clock.t));
  assert.deepEqual([r.status, r.reason], [429, 'busy']);
  s.cf.mintDown = true;
  const b = await mac();
  const t = await s.call(await b.request(s.clock.t));
  assert.deepEqual([t.status, t.reason], [502, 'turn']);
});

test('status: only with the owner key, and it shows everything', async () => {
  const s = await setup();
  const a = await mac();
  s.cf.usage.push({ hour: hour(s.clock.t, 1), ident: a.ident, bytes: 2 * GB });
  await s.call(await a.request(s.clock.t));
  const get = auth => handle(new Request('https://relay.example/v1/status', { headers: auth ? { Authorization: auth } : {} }), s.env, s.ledger, s.clock.t);
  assert.equal((await get()).status, 403);
  assert.equal((await get('Bearer wrong-key-wrong-key-wrong')).status, 403);
  const st = await (await get(`Bearer ${OWNER_KEY}`)).json();
  assert.equal(st.ok, true);
  assert.deepEqual(st.limits, { macGB: 20, othersGB: 900, totalGB: 990, windowDays: 31 });
  assert.equal(st.usedGB.total, 2);
  assert.equal(st.numbers.fresh, true);
  assert.deepEqual(st.macs.map(m => [m.ident, m.owner, m.bytes]), [[a.ident, false, 2 * GB]]);
  assert.equal(st.liveLogins, 1);
});

test('the usage query asks Cloudflare for egress bytes by hour, and by hour and Mac', () => {
  assert.match(USAGE_QUERY, /callsTurnUsageAdaptiveGroups/);
  assert.match(USAGE_QUERY, /sum \{ egressBytes \}/);
  assert.match(USAGE_QUERY, /dimensions \{ datetimeHour customIdentifier \}/);
  assert.match(USAGE_QUERY, /date_geq: \$from, date_leq: \$to/);
});

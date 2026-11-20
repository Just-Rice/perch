// Perch's feedback box (feedback/src/handler.js): sending, the checks against spam, and the owner-only reading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, sameToken, MAX_MESSAGE, DAILY_CAP } from '../../feedback/src/handler.js';

const SITE = 'https://just-rice.github.io';
const BASE = 'https://perch-feedback.example.workers.dev';

function rig({ turnstile = true, limitOk = true } = {}) {
  const rows = [];
  const deps = {
    allowedOrigins: [SITE, 'https://perch-relay.example.workers.dev'],
    verifyTurnstile: async (token) => ({ success: turnstile && token === 'ok', action: 'feedback' }),
    limit: async () => limitOk,
    store: {
      insert: async (r) => { rows.push({ id: rows.length + 1, status: 'new', notes: null, ...r }); },
      countSince: async (iso) => rows.filter(r => r.created_at >= iso).length,
      list: async ({ status, since }) => rows.filter(r => (!status || r.status === status) && (!since || r.created_at >= since)),
      update: async (id, patch) => { const r = rows.find(x => x.id === id); if (!r) return false; Object.assign(r, patch); return true; },
    },
    digestToken: 'digest-token-123', adminToken: 'admin-token-456', now: () => Date.parse('2026-11-20T12:00:00Z'),
  };
  return { rows, deps };
}

const send = (deps, body, { origin = SITE, ip = '203.0.113.9' } = {}) => handle(new Request(`${BASE}/v1/feedback`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin, 'cf-connecting-ip': ip }, body: JSON.stringify(body),
}), deps);
const admin = (deps, path, { token, method = 'GET', body } = {}) => handle(new Request(`${BASE}${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
}), deps);

test('a message from the website is kept, with only what the page says it keeps', async () => {
  const { rows, deps } = rig();
  const r = await send(deps, { kind: 'idea', message: '  Let me paste images  ', contact: 'me@example.com', os: 'windows',
    version: '0.4.1', source: 'viewer', turnstile: 'ok', website: '' });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('access-control-allow-origin'), SITE);
  assert.deepEqual(rows[0], { id: 1, status: 'new', notes: null, created_at: '2026-11-20T12:00:00.000Z', kind: 'idea',
    message: 'Let me paste images', contact: 'me@example.com', os: 'windows', version: '0.4.1', source: 'viewer' });
  assert.ok(!JSON.stringify(rows).includes('203.0.113.9'), 'the address is never kept');
});

test('junk values are tidied, not kept as they came', async () => {
  const { rows, deps } = rig();
  await send(deps, { kind: 'rant', message: 'hello there', os: 'amiga', version: 'x<script>', source: 'evil', turnstile: 'ok' });
  assert.deepEqual([rows[0].kind, rows[0].os, rows[0].version, rows[0].source, rows[0].contact], ['other', null, null, 'site', null]);
});

test('other sites, bots, robots, floods and oversized messages are turned away', async () => {
  const { rows, deps } = rig();
  assert.equal((await send(deps, { message: 'hi there', turnstile: 'ok' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send(deps, { message: 'hi there', turnstile: 'ok', website: 'http://spam' })).status, 201, 'a bot is thanked…');
  assert.equal(rows.length, 0, '…and nothing is kept');
  assert.equal((await send(deps, { message: 'hi there', turnstile: 'nope' })).status, 403, 'the robot check failed');
  assert.equal((await send(deps, { message: 'x'.repeat(MAX_MESSAGE + 1), turnstile: 'ok' })).status, 400);
  assert.equal((await send(deps, { message: 'ok', turnstile: 'ok' })).status, 400, 'too short');
  const flooded = rig({ limitOk: false });
  assert.equal((await send(flooded.deps, { message: 'hi there', turnstile: 'ok' })).status, 429);
  const big = await handle(new Request(`${BASE}/v1/feedback`, { method: 'POST', headers: { origin: SITE }, body: 'x'.repeat(9000) }), deps);
  assert.equal(big.status, 413);
  assert.equal(rows.length, 0);
});

test('a full day stops at the cap', async () => {
  const { rows, deps } = rig();
  for (let i = 0; i < DAILY_CAP; i++) rows.push({ id: i + 1, created_at: '2026-11-20T11:00:00.000Z', status: 'new' });
  assert.equal((await send(deps, { message: 'one more', turnstile: 'ok' })).status, 503);
});

test('a page asking first (CORS) is answered only for Perch’s own pages', async () => {
  const { deps } = rig();
  const ok = await handle(new Request(`${BASE}/v1/feedback`, { method: 'OPTIONS', headers: { origin: SITE } }), deps);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-methods'), 'POST');
  const no = await handle(new Request(`${BASE}/v1/feedback`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), deps);
  assert.equal(no.status, 403);
});

test('only the owner reads it: the digest token reads, only the admin token changes', async () => {
  const { rows, deps } = rig();
  await send(deps, { message: 'first idea', turnstile: 'ok' });
  assert.equal((await admin(deps, '/v1/admin/feedback')).status, 401);
  assert.equal((await admin(deps, '/v1/admin/feedback', { token: 'wrong' })).status, 401);
  const list = await admin(deps, '/v1/admin/feedback?status=new', { token: 'digest-token-123' });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).items[0].message, 'first idea');
  assert.equal((await admin(deps, '/v1/admin/feedback/1', { token: 'digest-token-123', method: 'PATCH', body: { status: 'approved' } })).status, 403,
    'the digest can only read');
  assert.equal((await admin(deps, '/v1/admin/feedback/1', { token: 'admin-token-456', method: 'PATCH', body: { status: 'approved', notes: 'yes' } })).status, 200);
  assert.deepEqual([rows[0].status, rows[0].notes], ['approved', 'yes']);
  assert.equal((await admin(deps, '/v1/admin/feedback/99', { token: 'admin-token-456', method: 'PATCH', body: { status: 'done' } })).status, 404);
  assert.equal((await admin(deps, '/v1/admin/feedback/1', { token: 'admin-token-456', method: 'PATCH', body: { status: 'deleted' } })).status, 400);
  assert.equal((await admin(deps, '/v1/elsewhere', { token: 'admin-token-456' })).status, 404);
});

test('tokens compare in constant shape', () => {
  assert.equal(sameToken('abc', 'abc'), true);
  assert.equal(sameToken('abd', 'abc'), false);
  assert.equal(sameToken('abcd', 'abc'), false);
  assert.equal(sameToken('abc', ''), false, 'an unset token never matches');
  assert.equal(sameToken(undefined, 'abc'), false);
});

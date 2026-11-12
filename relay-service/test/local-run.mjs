// Runs the relay service in Cloudflare's own runtime on this computer (`wrangler dev`, nothing uploaded), against a
// pretend Cloudflare API, and checks the parts Node can't: Ed25519 and SQLite in a Durable Object, and the cron.
//   node relay-service/test/local-run.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { requestText } from '../src/request.js';
import { toB64url } from '../../site/js/shared/bytes.js';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const enc = new TextEncoder();
const GB = 1e9;
const seen = { minted: [], revoked: [], queries: 0 };
let usageBytes = 0, usageIdent = null;

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj == null ? '' : JSON.stringify(obj)); };
    if (req.url.endsWith('/credentials/generate')) {
      const b = JSON.parse(body);
      const username = `u${seen.minted.length + 1}`;
      seen.minted.push({ username, ...b });
      return send(201, { iceServers: { urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username, credential: 'c' } });
    }
    if (req.url.endsWith('/revoke')) { seen.revoked.push(req.url.split('/').at(-2)); return send(204); }
    if (req.url === '/graphql') {
      seen.queries++;
      const hour = new Date().toISOString().slice(0, 13) + ':00:00Z';
      const rows = usageIdent ? [{ dimensions: { datetimeHour: hour, customIdentifier: usageIdent }, sum: { egressBytes: usageBytes } }] : [];
      return send(200, { data: { viewer: { accounts: [{ total: rows.map(r => ({ dimensions: { datetimeHour: hour }, sum: r.sum })), byMac: rows }] } } });
    }
    send(404, {});
  });
}).listen(0, '127.0.0.1');
await new Promise(r => mock.once('listening', r));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

const port = 20000 + Math.floor(Math.random() * 20000);
const vars = {
  TURN_KEY_ID: 'key123456', TURN_KEY_API_TOKEN: 'x', ACCOUNT_ID: 'acct', ANALYTICS_TOKEN: 'y',
  OWNER_KEY: 'owner-key-for-local-run-0123456789', TEST_TURN_URL: `${mockUrl}/v1/turn/keys`, TEST_GRAPHQL_URL: `${mockUrl}/graphql`,
};
const wrangler = spawn('npx', ['--yes', 'wrangler@4', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--test-scheduled',
  '--persist-to', path.join(process.env.TMPDIR ?? '/tmp', `perch-relay-local-${process.pid}`),
  ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])],
  { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
wrangler.stdout.on('data', d => { out += d; });
wrangler.stderr.on('data', d => { out += d; });
const base = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    if (i > 120) throw new Error(`wrangler dev did not start:\n${out.slice(-3000)}`);
    await new Promise(r => setTimeout(r, 500));
  }
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const mac = toB64url(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const ask = async () => {
    const ts = Date.now();
    const sig = toB64url(new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, enc.encode(requestText({ mac, ts })))));
    const r = await fetch(`${base}/v1/ice`, { method: 'POST', body: JSON.stringify({ v: 1, mac, ts, sig }) });
    return { status: r.status, ...(await r.json()) };
  };
  const first = await ask();
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.ttl, 10800);
  assert.equal(seen.minted.length, 1);
  usageIdent = seen.minted[0].customIdentifier;
  console.log(`PASS a signed request gets a login in Cloudflare's runtime (tagged ${usageIdent})`);

  usageBytes = 25 * GB;
  const cron = await fetch(`${base}/__scheduled?cron=*/5+*+*+*+*`);
  assert.equal(cron.status, 200);
  for (let i = 0; i < 40 && seen.revoked.length === 0; i++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(seen.revoked, ['u1']);
  console.log('PASS the five-minute cron read 25 GB for that Mac and revoked its login');
  const after = await ask();
  assert.deepEqual([after.status, after.reason], [403, 'mac']);
  console.log('PASS that Mac is now refused (over its 20 GB)');

  const st = await fetch(`${base}/v1/status`, { headers: { Authorization: `Bearer ${vars.OWNER_KEY}` } });
  const status = await st.json();
  assert.equal(status.usedGB.total, 25);
  console.log('PASS the owner’s status page shows the numbers');
} finally {
  wrangler.kill('SIGINT');
  mock.close();
}

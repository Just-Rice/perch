// The real Swift app and the real host together, with the real website: Perch (host/app, --synthetic: a moving test
// picture encoded by VideoToolbox and a test tone encoded by AudioToolbox, --echo-input: input is reported, never
// performed) starts the host (host/node/src/main.mjs) exactly as it does in Perch.app; the test sets the Mac up
// through the Setup page's own API, then pairs and signs in from headless Chrome.
//   swift build -c release --package-path host/app && node --test tests/e2e/app.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startStack, openPage, sleep } from '../site/lib/browser.mjs';
import { fromBase32, totp } from '../../host/node/src/totp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// PERCH_E2E_APP=/path/to/Perch.app tests a packaged app instead: its own bundled Node.js and bundled host.
const BUNDLE = process.env.PERCH_E2E_APP || null;
const APP = BUNDLE ? join(BUNDLE, 'Contents/MacOS/Perch') : join(ROOT, 'host/app/.build/release/Perch');
const HOST = join(ROOT, 'host/node/src/main.mjs');

const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

let stack, perch, home, setup, secret, usedSteps = new Set();

// Calls the Setup page's API the way the page does.
async function api(action, body) {
  const url = `http://127.0.0.1:${setup.port}/api/${action}`;
  const res = await fetch(url, body === undefined ? { headers: { 'X-Perch-Key': setup.key } } : {
    method: 'POST',
    headers: { 'X-Perch-Key': setup.key, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${setup.port}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${action}: ${json.error}`);
  return json;
}
// GET /api/state answers with the state itself; POSTs answer {result, state}.
const state = () => api('state');

// A code for a 30-second step not used yet (each step works once). Waits for the next step if needed.
async function freshCode() {
  for (;;) {
    const step = Math.floor(Date.now() / 30000);
    if (!usedSteps.has(step)) { usedSteps.add(step); return totp(secret, Date.now()); }
    await sleep(1000);
  }
}

test.before(async () => {
  assert.ok(existsSync(APP), `build the app first: swift build -c release --package-path host/app`);
  stack = await startStack();
  home = mkdtempSync(join(tmpdir(), 'perch-app-e2e-'));
  setup = { port: await freePort(), key: randomBytes(32).toString('base64url') };
  const node = execFileSync('/bin/sh', ['-c', 'command -v node']).toString().trim();
  const args = ['--synthetic', '--echo-input', '--no-ui', ...(BUNDLE ? [] : ['--node', node, '--host', HOST])];
  perch = spawn(APP, args, {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PERCH_TEST: '1', PERCH_HOME: home, PERCH_SECRETS: 'file', PERCH_BROKERS: stack.broker.url, PERCH_ICE: 'none',
      PERCH_TEST_ORIGIN: `http://localhost:${stack.port}`, PERCH_RP_ID: 'localhost', PERCH_SITE: `${stack.base}connect.html`,
      PERCH_SETUP_PORT: String(setup.port), PERCH_SETUP_KEY: setup.key,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  perch.log = '';
  perch.stdout.on('data', d => { perch.log += d; });
  perch.stderr.on('data', d => { perch.log += d; });
  // Wait for the Setup server and for the host to reach the broker.
  for (let i = 0; ; i++) {
    try {
      const s = await state();
      if (s.rendezvous?.some(b => b.connected)) break;
    } catch {}
    if (i > 150) throw new Error(`Perch didn't come up:\n${perch.log.slice(-3000)}`);
    await sleep(200);
  }
});

test.after(async () => {
  await stack?.closePages();
  if (perch && perch.exitCode === null) {
    perch.kill('SIGTERM');
    await Promise.race([new Promise(r => perch.once('exit', r)), sleep(5000)]);
    if (perch.exitCode === null) perch.kill('SIGKILL');
  }
  await stack?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

test('the real app and host: set up, pair from the website, picture and sound from VideoToolbox, input reported', async () => {
  const s0 = await state();
  assert.equal(s0.test, true);
  // Run from this terminal, the bare binary borrows the terminal's permission; a packaged Perch.app is judged on its
  // own (and has none yet), which synthetic mode doesn't need.
  if (!BUNDLE) assert.equal(s0.permissions.screen, true, 'synthetic mode needs no Screen Recording');
  assert.equal(s0.state, 'needs-setup');
  const { result: t } = await api('totpStart', {});
  secret = fromBase32(t.secret);
  await api('totpConfirm', { code: await freshCode() });
  const { result: pairing } = await api('pairStart', {});
  const page = await openPage(stack,
    pairing.link.replace('connect.html#', `connect.html?test=1&brokers=${encodeURIComponent(stack.broker.url)}#`), { name: 'app-pair' });
  await page.waitScreen('pair', { timeoutMs: 20000 });
  await page.click('#btnCreate');
  await page.waitScreen('code', { timeoutMs: 20000 });
  await page.click('#code');
  await page.type(await freshCode());
  await page.waitScreen('viewer', { timeoutMs: 20000 });
  await page.waitFor(`document.getElementById('video').videoWidth > 0`, { timeoutMs: 20000, what: 'video from the app' });
  const t0 = await page.eval(`document.getElementById('video').currentTime`);
  await sleep(1000);
  assert.ok(await page.eval(`document.getElementById('video').currentTime`) > t0, 'the test picture is moving');
  // Sound arrives: the test tone's packets reach the browser's audio receiver.
  const audio = await page.waitFor(`(async () => { const pc = window.__perch?.conn?.pc; if (!pc) return 0;
    let n = 0; (await pc.getStats()).forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') n = r.packetsReceived; }); return n > 20 && n; })()`,
    { timeoutMs: 10000, what: 'audio packets' }).catch(() => null);
  // Clicks in the middle reach the app, which reports them instead of clicking. Without Accessibility (a packaged
  // app nobody has allowed yet) the session is view only: the page says so and nothing is forwarded.
  const box = await page.eval(`(() => { const r = document.getElementById('surface').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(null, box);
  const canControl = (await state()).permissions.accessibility;
  let echoed = [];
  for (let i = 0; i < 50; i++) {
    echoed = (await api('test/input-echo')).result ?? (await api('test/input-echo'));
    if (!canControl || (Array.isArray(echoed) && echoed.length >= 2)) break;
    await sleep(100);
  }
  if (canControl) {
    assert.ok(Array.isArray(echoed) && echoed.length >= 2, `input reached the app: ${JSON.stringify(echoed).slice(0, 300)}`);
  } else {
    await page.waitFor(`!!document.querySelector('#banners [data-id="viewonly"]')`, { what: 'the view-only note' });
    assert.deepEqual(echoed, [], 'nothing forwarded without Accessibility');
  }
  const s1 = await state();
  assert.equal(s1.session?.route, 'pair');
  assert.equal(s1.state, 'connected');
  test.diagnostic?.(`audio packets: ${audio}`);
  assert.ok(audio, 'audio packets from the app arrived');
  assert.deepEqual(page.problems(), []);
});

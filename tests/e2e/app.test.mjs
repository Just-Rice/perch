// The real roost.exe and the real host together, with the real website: roost (app/, --synthetic: a moving test
// picture encoded by OpenH264 and a test tone encoded by libopus, --echo-input: input is reported, never performed)
// starts the host (host/src/main.mjs) exactly as it does when installed; the test sets the PC up through the Control
// Center's own API, then pairs and signs in from headless Chrome. Runs on Windows (CI), and on a Mac or Linux too,
// where the app's portable core runs the same synthetic session.
//   (cd app && cargo build --release) && node --test tests/e2e/app.test.mjs
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
import { fromBase32, totp } from '../../host/src/totp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// ROOST_E2E_APP=<folder of an unzipped release> tests a packaged Roost instead: its own bundled Node.js and host.
const BUNDLE = process.env.ROOST_E2E_APP || null;
const EXE = process.platform === 'win32' ? 'roost.exe' : 'roost';
const APP = BUNDLE ? join(BUNDLE, EXE) : join(ROOT, 'app/target/release', EXE);
const HOST = join(ROOT, 'host/src/main.mjs');

const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

let stack, roost, home, setup, secret, usedSteps = new Set();

// Calls the Setup page's API the way the page does.
async function api(action, body) {
  const url = `http://127.0.0.1:${setup.port}/api/${action}`;
  const res = await fetch(url, body === undefined ? { headers: { 'X-Roost-Key': setup.key } } : {
    method: 'POST',
    headers: { 'X-Roost-Key': setup.key, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${setup.port}` },
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
  assert.ok(existsSync(APP), `build the app first: (cd app && cargo build --release)`);
  stack = await startStack();
  home = mkdtempSync(join(tmpdir(), 'roost-app-e2e-'));
  setup = { port: await freePort(), key: randomBytes(32).toString('base64url') };
  const node = process.execPath;
  const args = ['--synthetic', '--echo-input', '--no-ui', ...(BUNDLE ? [] : ['--node', node, '--host', HOST])];
  roost = spawn(APP, args, {
    env: {
      ...process.env,
      ROOST_TEST: '1', ROOST_HOME: home, ROOST_SECRETS: 'file', ROOST_BROKERS: stack.broker.url, ROOST_ICE: 'none',
      ROOST_TEST_ORIGIN: `http://localhost:${stack.port}`, ROOST_RP_ID: 'localhost', ROOST_SITE: `${stack.base}connect.html`,
      ROOST_SETUP_PORT: String(setup.port), ROOST_SETUP_KEY: setup.key,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  roost.log = '';
  roost.stdout.on('data', d => { roost.log += d; });
  roost.stderr.on('data', d => { roost.log += d; });
  // Wait for the Setup server and for the host to reach the broker.
  for (let i = 0; ; i++) {
    try {
      const s = await state();
      if (s.rendezvous?.some(b => b.connected)) break;
    } catch {}
    if (i > 150) throw new Error(`Roost didn't come up:\n${roost.log.slice(-3000)}`);
    await sleep(200);
  }
});

test.after(async () => {
  await stack?.closePages();
  if (roost && roost.exitCode === null) {
    roost.kill('SIGTERM');
    await Promise.race([new Promise(r => roost.once('exit', r)), sleep(5000)]);
    if (roost.exitCode === null) roost.kill('SIGKILL');
  }
  await stack?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

test('the real app and host: set up, pair from the website, picture from OpenH264, sound from Opus, input reported', async () => {
  const s0 = await state();
  assert.equal(s0.test, true);
  assert.equal(s0.permissions.screen, true, 'Windows has no Screen Recording permission');
  assert.equal(s0.app?.features?.encoder, 'OpenH264');
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
  // OpenH264 makes Constrained Baseline, which every H.264 decoder plays, whichever profile the SDP agreed.
  const codec = await page.eval(`(async () => { let id = null, out = null; const st = await window.__roost.conn.pc.getStats();
    st.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') id = r.codecId; });
    st.forEach(r => { if (r.id === id) out = r.sdpFmtpLine; }); return out; })()`);
  // A browser without High (Chrome on a Mac with no graphics chip, like the CI's) gets Baseline instead.
  const high = await page.eval(`RTCRtpReceiver.getCapabilities('video').codecs
    .some(c => /h264/i.test(c.mimeType) && /profile-level-id=64/.test(c.sdpFmtpLine ?? ''))`);
  assert.match(codec ?? '', /profile-level-id=(640c1f|64001f|42e01f)/, `an H.264 codec agreed (browser ${high ? 'has' : 'lacks'} High): ${codec}`);
  // Sound arrives: the test tone's packets reach the browser's audio receiver.
  const audio = await page.waitFor(`(async () => { const pc = window.__roost?.conn?.pc; if (!pc) return 0;
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
  // One window: the picker lists the app's pretend window (800 by 600), and choosing it turns the picture into
  // just that window, in its 4:3 shape.
  await page.eval(`window.__roost.viewer._toggleTweaks(true)`);
  await sleep(300); // Tweaks slides in
  await page.waitFor(`[...document.getElementById('optWindow').options].some(o => o.textContent === 'Test App: Test Window')`,
    { timeoutMs: 10000, what: 'the list of windows from the app' });
  await page.eval(`(() => { const s = document.getElementById('optWindow'); s.value = '7'; s.dispatchEvent(new Event('change')); })()`);
  await page.waitFor(`(() => { const v = document.getElementById('video'); return v.videoWidth > 0 && Math.abs(v.videoWidth / v.videoHeight - 4 / 3) < 0.01; })()`,
    { timeoutMs: 15000, what: 'a picture in the window\'s shape' });
  const s1 = await state();
  assert.equal(s1.session?.route, 'pair');
  assert.equal(s1.state, 'connected');
  test.diagnostic?.(`audio packets: ${audio}`);
  assert.ok(audio, 'audio packets from the app arrived');
  assert.deepEqual(page.problems(), []);
});

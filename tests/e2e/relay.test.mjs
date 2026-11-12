// The Worker relay end to end: the real relay Worker (relay/, run by `wrangler dev`), the real Mac host (test mode,
// with the stand-in app's test video and sound) and the real website in headless Chrome, told to use the relay
// (?transport=relay stands in for a network that blocks WebRTC). Covers setting the relay up from Setup's API, pairing
// and signing in over it (the pinned Mac's signed relay offer), the picture and sound arriving, and input reaching the Mac.
// Also the relay as a rendezvous broker and as a host of the website: with the public brokers out of reach, a page
// served by the relay finds the Mac through the relay alone.
//   (cd relay && npm ci) && node --test tests/e2e/relay.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { startStack, openPage, sleep } from '../site/lib/browser.mjs';
import { startHost } from '../../host/node/test/fake-app.mjs';
import { MqttClient } from '../../site/js/shared/mqtt.js';
import { relayBroker } from '../../site/js/shared/wsrelay.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WRANGLER = join(ROOT, 'relay/node_modules/.bin/wrangler');
// PERCH_E2E_RELAY=https://<a fresh, unclaimed deploy>.workers.dev runs these against a relay on Cloudflare itself.
const DEPLOYED = process.env.PERCH_E2E_RELAY || null;
const skip = DEPLOYED || existsSync(WRANGLER) ? false : 'relay/node_modules is missing: run `npm ci` in relay/ first';

let stack, app, relay, relayUrl;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// `wrangler dev` with its own empty storage, so the relay starts unclaimed.
async function startRelay() {
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), 'perch-relay-'));
  const proc = spawn(WRANGLER, ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, '--log-level', 'warn'],
    { cwd: join(ROOT, 'relay'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  let output = '';
  proc.stdout.on('data', d => { output += d; });
  proc.stderr.on('data', d => { output += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${url}/v1/info`)).ok) return { url, proc, state, output: () => output }; } catch {}
    if (proc.exitCode !== null) break;
    await sleep(500);
  }
  proc.kill();
  throw new Error(`wrangler dev didn't start:\n${output.slice(-2000)}`);
}

test.before(async () => {
  if (skip) return;
  if (DEPLOYED) relayUrl = DEPLOYED.replace(/\/$/, '');
  else {
    relay = await startRelay();
    relayUrl = relay.url;
  }
  stack = await startStack();
  app = await startHost({
    broker: stack.broker.url,
    origin: `http://localhost:${stack.port}`,
    rpId: 'localhost',
    site: `${stack.base}connect.html`,
  });
  await app.setupTotp();
});
test.after(async () => {
  await app?.stop();
  await stack?.close();
  relay?.proc.kill();
  if (relay) rmSync(relay.state, { recursive: true, force: true });
});
test.afterEach(async (t) => {
  for (const p of stack?.pages ?? []) {
    try {
      const shown = await p.eval(`[document.getElementById('msgTitle')?.textContent, document.getElementById('msgBody')?.textContent,
        document.getElementById('passkeyError')?.textContent, document.getElementById('codeError')?.textContent].filter(Boolean).join(' | ')`);
      if (shown) t.diagnostic(`page ${p.name}: ${shown}`);
    } catch {}
  }
  await stack?.auth.credentials();
  await stack?.closePages();
});

const testParams = () => `test=1&transport=relay&brokers=${encodeURIComponent(stack.broker.url)}`;

async function enterCode(page) {
  await page.waitScreen('code', { timeoutMs: 20000 });
  const code = await app.freshCode();
  await page.click('#code');
  await page.type(code);
  await sleep(300);
  if ((await page.screen()) === 'code') await page.click('#btnCode').catch(() => {});
}

async function assertPlaying(page) {
  await page.waitScreen('viewer', { timeoutMs: 20000 });
  await page.waitFor(`document.getElementById('video').videoWidth > 16`, { timeoutMs: 15000, what: 'video frames over the relay' });
  const t0 = await page.eval(`document.getElementById('video').currentTime`);
  await sleep(700);
  assert.ok(await page.eval(`document.getElementById('video').currentTime`) > t0, 'the picture is moving');
  assert.equal(await page.eval(`document.getElementById('video').srcObject.getAudioTracks().length`), 1, 'sound track');
  // The sound really arrives and is decoded, not just a silent track.
  await page.waitFor(`window.__perch.conn?.media?.stats.audio > 20`, { timeoutMs: 10000, what: 'sound packets over the relay' });
}

async function assertInputReachesMac(page) {
  const before = app.inputs.length;
  const box = await page.eval(`(() => { const r = document.getElementById('surface').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.mouse('mouseMoved', box.x, box.y);
  await page.click(null, box);
  await app.waitFor(() => app.inputs.slice(before).filter(i => i.ev.t === 'b').length >= 2, { what: 'clicks at the Mac' });
  const down = app.inputs.slice(before).map(i => i.ev).find(e => e.t === 'b' && e.d);
  assert.ok(Math.abs(down.x - 0.5) < 0.02 && Math.abs(down.y - 0.5) < 0.02, `click in the middle (${down.x}, ${down.y})`);
}

test('setting up the relay: Perch claims a new relay, and refuses an address that isn’t one', { skip }, async () => {
  await assert.rejects(app.call('workerRelaySet', 'https://example.com'), /doesn’t look right/);
  await app.call('workerRelaySet', relayUrl);
  const st = (await app.call('state')).workerRelay;
  assert.equal(st.set, true);
  assert.equal(st.url, relayUrl);
  assert.equal((await (await fetch(`${relayUrl}/v1/info`)).json()).claimed, true, 'the relay now has an owner');
  // Saving the same relay again is fine: this Mac already owns it.
  await app.call('workerRelaySet', relayUrl);
  // Anyone else trying to become its owner is refused.
  const other = await fetch(`${relayUrl}/v1/claim`, { method: 'POST', body: JSON.stringify({ secret: 'ab'.repeat(32) }) });
  assert.equal(other.status, 409);
  // ...and can't open a room as the Mac.
  assert.equal(await upgradeStatus(`${relayUrl}/v1/room/${'A'.repeat(22)}?role=mac&auth=${'00'.repeat(32)}`), 403);
});

// The status a WebSocket upgrade request gets (fetch won't send an Upgrade header).
function upgradeStatus(url) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('response', res => { res.resume(); resolve(res.statusCode); });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('error', reject);
    req.end();
  });
}

test('pairing over the relay: the Mac on screen with sound, and input reaching the Mac', { skip }, async () => {
  const { link } = await app.call('pairStart');
  const page = await openPage(stack, link.replace('connect.html#', `connect.html?${testParams()}#`), { name: 'pair-relay' });
  await page.waitScreen('pair', { timeoutMs: 20000 });
  await page.click('#btnCreate');
  await enterCode(page);
  await assertPlaying(page);
  assert.equal(await page.eval(`window.__perch.conn.via`), 'relay', 'the viewer used the relay');
  await assertInputReachesMac(page);
  const st = await app.call('state');
  assert.equal(st.session?.route, 'pair');
  assert.equal(st.session?.transport, 'relay', 'the Mac used the relay');
  assert.equal((await stack.auth.credentials()).length, 1, 'one passkey made');
  await page.click('#tbBye');
  await app.waitFor(async () => !(await app.call('state')).session, { what: 'session over' });
  assert.deepEqual(page.problems(), []);
});

test('signing in again over the relay: the pinned Mac’s signed offer, passkey, then code', { skip }, async () => {
  const page = await openPage(stack, `${stack.base}connect.html?${testParams()}`, { name: 'signin-relay' });
  await page.waitScreen('home');
  await page.waitFor(`document.querySelectorAll('#macList button').length > 0`, { what: 'the remembered Mac' });
  // The remembered Mac carries its certificate pin, so the relay offer had to be signed by that certificate.
  assert.ok(await page.eval(`!!JSON.parse(localStorage.getItem('perch.macs.v1'))[0].pin`), 'the Mac is pinned');
  await page.click('#macList button');
  await page.waitScreen(['code', 'passkey'], { timeoutMs: 20000 });
  if ((await page.screen()) === 'passkey') await page.click('#btnPasskeyGo');
  await enterCode(page);
  await assertPlaying(page);
  assert.equal(await page.eval(`window.__perch.conn.via`), 'relay');
  assert.equal((await app.call('state')).session?.transport, 'relay');
  // Changing the quality goes over the relay's control channel and reaches the Mac.
  await page.eval(`window.__perch.conn.send({ t: 'quality', preset: 'smooth' })`);
  await app.waitFor(() => app.commands.some(c => c.c === 'capture' && c.kbps <= 4000), { what: 'smooth quality at the Mac' });
  await page.click('#tbBye');
  await app.waitFor(async () => !(await app.call('state')).session, { what: 'session over' });
  assert.deepEqual(page.problems(), []);
});

test('the relay is a rendezvous broker: Perch’s own MQTT client meets there, on Perch’s topics only', { skip }, async () => {
  const url = relayBroker(relayUrl);
  const a = new MqttClient(url), b = new MqttClient(url);
  await a.connect();
  await b.connect();
  const got = [];
  b.onmessage = (topic, payload) => got.push([topic, new TextDecoder().decode(payload)]);
  await b.subscribe('perch/v1/h/test-topic');
  a.publish('perch/v1/h/test-topic', 'sealed');
  a.publish('perch/v1/h/other-topic', 'not for b');
  for (let i = 0; i < 50 && !got.length; i++) await sleep(100);
  assert.deepEqual(got, [['perch/v1/h/test-topic', 'sealed']]);
  // No wildcards (nobody can listen to everything) and nothing outside Perch's topics.
  const c = new MqttClient(url);
  await c.connect();
  const sniffed = [];
  c.onmessage = (topic) => sniffed.push(topic);
  c.subscribe('#').catch(() => {});
  c.subscribe('perch/v1/#').catch(() => {});
  await sleep(300);
  a.publish('perch/v1/h/test-topic', 'sealed again');
  a.publish('other/topic', 'x');
  await sleep(700);
  assert.deepEqual(sniffed, [], 'a wildcard subscriber hears nothing');
  assert.equal(got.length, 2, 'b got the second message and nothing outside perch/v1/');
  c.close();
  a.close();
  b.close();
});

test('where only the relay gets through: a page it serves pairs and signs in, finding the Mac through it alone', { skip }, async () => {
  // The Mac listens on the relay's broker as soon as the relay is set up (it was, in the first test).
  await app.waitFor(async () => (await app.call('state')).rendezvous.some(r => r.url.endsWith('/v1/mqtt') && r.connected),
    { what: 'the Mac on the relay’s broker' });
  // The website as the relay serves it, from the relay's own address (localhost: passkeys need a name, not an IP).
  const origin = DEPLOYED ? relayUrl : relayUrl.replace('127.0.0.1', 'localhost');
  const page0 = await fetch(`${origin}/connect.html`);
  assert.equal(page0.status, 200);
  assert.match(await page0.text(), /Perch/);
  // Locally both sites are on localhost, so the passkey from the tests above would count as this site's too ("already
  // paired"). On the real thing they are different addresses; forget the earlier device to model that.
  if (!DEPLOYED) await app.call('devicesRemoveAll');
  await app.call('siteAdd', `${origin}/`);
  const { link } = await app.call('pairStart', origin);
  assert.ok(link.startsWith(`${origin}/connect.html#pair=`), link);
  // Locally, the only public broker the page may use is a dead one: it can only find the Mac through the relay.
  const local = DEPLOYED ? '' : `test=1&relaysite=1&transport=relay&brokers=${encodeURIComponent('ws://127.0.0.1:9/')}`;
  const page = await openPage(stack, local ? link.replace('connect.html#', `connect.html?${local}#`) : link, { name: 'relay-site' });
  await page.waitScreen('pair', { timeoutMs: 20000 });
  await page.click('#btnCreate');
  await enterCode(page);
  await page.waitScreen('viewer', { timeoutMs: 20000 });
  await page.waitFor(`document.getElementById('video').videoWidth > 16`, { timeoutMs: 15000, what: 'video' });
  await assertInputReachesMac(page);
  // The Mac named its relay, and the page remembers it for next time.
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem('perch.macs.v1'))[0].relay`), DEPLOYED ? relayUrl : relayUrl);
  await page.click('#tbBye');
  await app.waitFor(async () => !(await app.call('state')).session, { what: 'session over' });
});

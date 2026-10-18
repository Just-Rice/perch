// The whole system end to end: the real website (site/, in headless Chrome with a virtual passkey) and the real Mac
// host (host/node/src/main.mjs in test mode, with the stand-in app that plays test video and sound and echoes input),
// meeting through the local test broker. Covers pairing, passkey sign-in, backup sign-in and an about:blank tab.
//   node --test tests/e2e/full.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openPage, Page, targetMatching, evalInFrame, sleep } from '../site/lib/browser.mjs';
import { startHost } from '../../host/node/test/fake-app.mjs';

let stack, app;

test.before(async () => {
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
});
test.afterEach(async (t) => {
  // When a test fails, say what the page was showing and what the host last logged.
  for (const p of stack?.pages ?? []) {
    try {
      const shown = await p.eval(`[document.getElementById('msgTitle')?.textContent, document.getElementById('msgBody')?.textContent,
        document.getElementById('passkeyError')?.textContent, document.getElementById('codeError')?.textContent].filter(Boolean).join(' | ')`);
      if (shown) t.diagnostic(`page ${p.name}: ${shown}`);
    } catch {}
  }
  // Each sign-in moves the passkey's counter on; pick up the newest counter before its tab (and authenticator) goes,
  // so the next tab's copy isn't refused as an old clone.
  await stack?.auth.credentials();
  await stack?.closePages();
});

const testParams = () => `test=1&brokers=${encodeURIComponent(stack.broker.url)}`;

// Types a fresh 6-digit code into the code screen.
async function enterCode(page) {
  await page.waitScreen('code', { timeoutMs: 20000 });
  const code = await app.freshCode();
  await page.click('#code');
  await page.type(code);
  // The form submits by itself at six digits; press the button too in case it doesn't.
  await sleep(300);
  if ((await page.screen()) === 'code') await page.click('#btnCode').catch(() => {});
}

// The viewer is showing a moving picture from the Mac, with sound attached.
async function assertPlaying(page) {
  await page.waitScreen('viewer', { timeoutMs: 20000 });
  await page.waitFor(`document.getElementById('video').videoWidth > 0`, { timeoutMs: 15000, what: 'video frames' });
  const t0 = await page.eval(`document.getElementById('video').currentTime`);
  await sleep(700);
  assert.ok(await page.eval(`document.getElementById('video').currentTime`) > t0, 'the picture is moving');
  assert.equal(await page.eval(`document.getElementById('video').srcObject.getAudioTracks().length`), 1, 'sound track');
}

// A click in the middle of the picture reaches the app as a pointer move plus button down and up.
async function assertInputReachesMac(page) {
  const before = app.inputs.length;
  const box = await page.eval(`(() => { const r = document.getElementById('surface').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.mouse('mouseMoved', box.x, box.y);
  await page.click(null, box);
  await app.waitFor(() => app.inputs.slice(before).filter(i => i.ev.t === 'b').length >= 2, { what: 'clicks at the Mac' });
  const got = app.inputs.slice(before).map(i => i.ev);
  const down = got.find(e => e.t === 'b' && e.d);
  assert.ok(Math.abs(down.x - 0.5) < 0.02 && Math.abs(down.y - 0.5) < 0.02, `click in the middle (${down.x}, ${down.y})`);
}

test('pairing a new device, then the Mac on screen with sound, and input reaching the Mac', async () => {
  const { link } = await app.call('pairStart');
  assert.match(link, /connect\.html#pair=[A-Za-z0-9_-]+$/);
  // The pairing link goes to the real site; in this test it must also say "use the local broker".
  const page = await openPage(stack, link.replace('connect.html#', `connect.html?${testParams()}#`), { name: 'pair' });
  await page.waitScreen('pair', { timeoutMs: 20000 });
  assert.equal(await page.eval('location.hash'), '', 'the secret was cleared from the address bar');
  await page.click('#btnCreate');
  await enterCode(page);
  await assertPlaying(page);
  await assertInputReachesMac(page);
  const st = await app.call('state');
  assert.equal(st.devices.length, 1, 'one paired device');
  assert.equal(st.session?.route, 'pair');
  assert.equal(JSON.parse(await page.eval(`localStorage.getItem('perch.macs.v1')`)).length, 1, 'the Mac is remembered');
  // Keep the new passkey for later tabs, as a synced passkey would be: the virtual authenticator goes with this tab.
  assert.equal((await stack.auth.credentials()).length, 1, 'one passkey made');
  await page.click('#tbBye');
  await app.waitFor(async () => !(await app.call('state')).session, { what: 'session over' });
  assert.deepEqual(page.problems(), []);
});

test('signing in again with the remembered Mac: passkey, then code', async () => {
  const page = await openPage(stack, `${stack.base}connect.html?${testParams()}`, { name: 'signin' });
  await page.waitScreen('home');
  await page.waitFor(`document.querySelectorAll('#macList button').length > 0`, { what: 'the remembered Mac' });
  await page.click('#macList button');
  // Either the browser accepted the passkey request straight away, or it asks for one more tap.
  await page.waitScreen(['code', 'passkey'], { timeoutMs: 20000 });
  if ((await page.screen()) === 'passkey') await page.click('#btnPasskeyGo');
  await enterCode(page);
  await assertPlaying(page);
  assert.equal((await app.call('state')).session?.route, 'passkey');
  assert.deepEqual(page.problems(), []);
});

test('a wrong code is refused and nothing is shown; the right one then works', async () => {
  const page = await openPage(stack, `${stack.base}connect.html?${testParams()}`, { name: 'wrongcode' });
  await page.waitScreen('home');
  await page.click('#macList button');
  await page.waitScreen(['code', 'passkey'], { timeoutMs: 20000 });
  if ((await page.screen()) === 'passkey') await page.click('#btnPasskeyGo');
  await page.waitScreen('code', { timeoutMs: 20000 });
  const right = await app.freshCode();
  const wrong = String((Number(right) + 1) % 1e6).padStart(6, '0');
  await page.click('#code');
  await page.type(wrong);
  await page.waitFor(`document.getElementById('codeError').textContent.trim().length > 0`, { what: 'wrong code message' });
  assert.equal(await page.eval(`document.getElementById('viewer').hidden`), true, 'no picture after a wrong code');
  await page.eval(`(() => { const c = document.getElementById('code'); c.value = ''; c.focus(); })()`);
  await page.type(right);
  await assertPlaying(page);
});

test('backup sign-in: Mac name and password (checked by OPAQUE), then the code', async () => {
  const opaque = await import('../../site/js/vendor/opaque/index.js');
  await opaque.ready;
  const password = 'amber-otter-quietly-sings-loud';
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });
  const { registrationResponse } = await app.call('backupRegisterStart', registrationRequest);
  const { registrationRecord } = opaque.client.finishRegistration({ clientRegistrationState, registrationResponse, password });
  await app.call('backupRegisterFinish', registrationRecord);
  const { macName, backup } = await app.call('state');
  assert.equal(backup.on, true);

  const page = await openPage(stack, `${stack.base}connect.html?${testParams()}`, { name: 'backup' });
  await page.waitScreen('home');
  await page.click('#btnBackup');
  await page.waitScreen('backup');
  // A wrong password first.
  await page.click('#macName');
  await page.type(macName);
  await page.click('#password');
  await page.type('not the password');
  await page.click('#btnBackupGo');
  await page.waitFor(`document.getElementById('backupError').textContent.trim().length > 0 || document.getElementById('msgTitle').textContent.length > 0`,
    { timeoutMs: 20000, what: 'wrong password message' });
  assert.equal(await page.eval(`document.getElementById('viewer').hidden`), true);
  // Then the right one.
  await page.goto(`${stack.base}connect.html?${testParams()}`);
  await page.waitScreen('home');
  await page.click('#btnBackup');
  await page.waitScreen('backup');
  await page.eval(`document.getElementById('macName').value = ''`);
  await page.click('#macName');
  await page.type(macName);
  await page.click('#password');
  await page.type(password);
  await page.click('#btnBackupGo');
  await enterCode(page);
  await assertPlaying(page);
  assert.equal((await app.call('state')).session?.route, 'backup');
});

test('inside an about:blank tab: same sign-in, same picture', async () => {
  const page = await openPage(stack, `${stack.base}connect.html?${testParams()}`, { name: 'opener' });
  await page.waitScreen('home');
  await page.click('#btnBlank');
  const tabSession = await targetMatching(stack, info => info.type === 'page' && info.url === 'about:blank' && info.openerId);
  const tab = new Page(stack, tabSession, [], 'blank-tab');
  stack.pages.add(tab);
  const inFrame = expr => evalInFrame(tab, u => u.includes('connect.html'), expr);
  for (let i = 0; i < 100; i++) {
    const n = await inFrame(`document.querySelectorAll('#macList button').length`);
    if (n > 0) break;
    await sleep(100);
  }
  assert.equal(await tab.eval('location.href'), 'about:blank', 'the tab really is about:blank');
  // Tap the remembered Mac inside the frame (the frame fills the tab, so its coordinates are the tab's).
  const at = await inFrame(`(() => { const r = document.querySelector('#macList button').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await tab.click(null, at);
  const screenIn = () => inFrame(`(() => { if (!document.getElementById('viewer').hidden) return 'viewer';
    const s = [...document.querySelectorAll('#main > .screen')].find(x => !x.hidden); return s && s.id.slice(2); })()`);
  let s;
  for (let i = 0; i < 200 && !['code', 'passkey'].includes(s = await screenIn()); i++) await sleep(100);
  if (s === 'passkey') {
    const b = await inFrame(`(() => { const r = document.getElementById('btnPasskeyGo').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await tab.click(null, b);
    for (let i = 0; i < 200 && (s = await screenIn()) !== 'code'; i++) await sleep(100);
  }
  assert.equal(s, 'code');
  const code = await app.freshCode();
  const c = await inFrame(`(() => { const r = document.getElementById('code').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await tab.click(null, c);
  await tab.type(code);
  for (let i = 0; i < 200 && (s = await screenIn()) !== 'viewer'; i++) await sleep(100);
  assert.equal(s, 'viewer');
  for (let i = 0; i < 150 && !(await inFrame(`document.getElementById('video').videoWidth > 0`)); i++) await sleep(100);
  assert.equal(await inFrame(`document.getElementById('video').videoWidth > 0`), true, 'video in the about:blank tab');
  assert.equal((await app.call('state')).session?.route, 'passkey');
});

test('"Sign in with a passkey" on a browser that doesn\'t remember the Mac asks for the passkey only once', async () => {
  let asked = 0;
  const off = stack.cdp.on(m => { if (m.method === 'WebAuthn.credentialAsserted') asked++; });
  try {
    const page = await openPage(stack, `${stack.base}connect.html?${testParams()}`, { name: 'one-tap' });
    await page.eval(`localStorage.removeItem('perch.macs.v1')`);
    await page.goto(`${stack.base}connect.html?${testParams()}`);
    await page.waitScreen('home');
    assert.equal(await page.eval(`document.querySelectorAll('#macList button').length`), 0, 'no remembered Mac');
    await page.click('#btnDiscover');
    await enterCode(page);
    await assertPlaying(page);
    assert.equal((await app.call('state')).session?.route, 'passkey');
    assert.equal(asked, 1, `passkey requests: ${asked}`);
    const macs = JSON.parse(await page.eval(`localStorage.getItem('perch.macs.v1')`));
    assert.equal(macs.length, 1);
    assert.match(macs[0].pin ?? '', /^[A-Za-z0-9_-]{22}$/, 'the Mac is remembered with its certificate pin');
    assert.deepEqual(page.problems(), []);
  } finally {
    off();
  }
});

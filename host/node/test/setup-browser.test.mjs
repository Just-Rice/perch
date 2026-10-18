// The Setup page in headless Chrome, against the mock controller (test/setup-mock-controller.mjs): every step is
// walked through with real clicks and typing, the QR codes are checked module by module, the backup password is
// registered with OPAQUE in the page and then checked with a real OPAQUE sign-in here, and the page must finish with
// no console errors, no security-policy violations and no pop-up dialogs. Screenshots of each major state, light and
// dark, desktop and narrow, go to tests/e2e/out/setup/.
// A second, shorter walk-through runs the page against the real host (src/main.mjs in test mode, with the local test
// broker and a stand-in for the Swift app), to catch any difference between the mock and the real controller.
// Run: node --test test/setup-browser.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import * as opaque from '@serenity-kit/opaque';
import { launchChrome, CHROME } from '../../../tests/e2e/cdp.mjs';
import { startBroker } from '../../../tests/e2e/broker.mjs';
import { startSetupServer } from '../src/setup-server.mjs';
import { totp, base32, otpauthUri, fromBase32 } from '../src/totp.mjs';
import { T, encodeJson, FrameReader } from '../src/ipc.mjs';
import { createMockController } from './setup-mock-controller.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', '..', 'tests', 'e2e', 'out', 'setup');
// The vendored qrcode-generator is a classic browser script that defines a global. This package is all ES modules,
// so require() would load it as one and hand back an empty module; it runs in a sandbox of its own here instead.
const qrcode = vm.runInNewContext(
  `${readFileSync(path.join(HERE, '..', 'setup', 'vendor', 'qrcode.js'), 'utf8')}\n;qrcode`, {}, { filename: 'qrcode.js' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a little page driver (its own, so no stray timers keep Node running) ---

// A DevTools call that fails after `ms` instead of waiting for ever. A reply can go missing (seen once when the Mac
// went to sleep in the middle of a run), and a run that hangs says much less than one that fails.
function timed(page, method, params, ms = 20_000) {
  let timer;
  return Promise.race([
    page.send(method, params),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer to ${method} in ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function evaluate(page, expression) {
  const r = await timed(page, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(`page exception: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  }
  return r.result.value;
}

async function waitFor(page, expression, what = expression, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await evaluate(page, expression).catch((e) => e.message);
    if (last === true || (last && last !== false && typeof last !== 'string')) return last;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what} (last: ${JSON.stringify(last)})`);
}

async function until(fn, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const q = (s) => JSON.stringify(s);
const text = (page, sel) => evaluate(page, `document.querySelector(${q(sel)})?.textContent.trim() ?? null`);
const visible = (page, sel) => evaluate(page, `(() => { const el = document.querySelector(${q(sel)}); return !!el && !!el.getClientRects().length; })()`);
const value = (page, sel) => evaluate(page, `document.querySelector(${q(sel)})?.value ?? null`);
const focusedText = (page) => evaluate(page, 'document.activeElement?.textContent.trim() || document.activeElement?.id || null');

// A real mouse click in the middle of the element, after checking nothing covers it.
async function click(page, selector) {
  const box = await evaluate(page, `(() => {
    const el = document.querySelector(${q(selector)});
    if (!el) return { missing: true };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { hidden: true };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const hit = top === el || el.contains(top) || [...(el.labels ?? [])].some(l => l.contains(top));
    return { x, y, hit, disabled: !!el.disabled, top: top?.outerHTML.slice(0, 80) };
  })()`);
  if (box.missing) throw new Error(`no element ${selector}`);
  if (box.hidden) throw new Error(`${selector} isn't visible`);
  if (!box.hit) throw new Error(`${selector} is covered by ${box.top}`);
  if (box.disabled) throw new Error(`${selector} is disabled`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
}

// Focuses a field, selects what's in it and types over it.
async function type(page, selector, textToType) {
  await evaluate(page, `(() => { const el = document.querySelector(${q(selector)}); el.focus(); el.select?.(); })()`);
  await page.send('Input.insertText', { text: textToType });
}

const KEYS = { Enter: 13, Escape: 27, Tab: 9 };
async function press(page, key) {
  const base = { key, code: key, windowsVirtualKeyCode: KEYS[key], nativeVirtualKeyCode: KEYS[key] };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// --- screenshots ---

const VIEWS = [
  { name: 'desktop', width: 1280, height: 800, scale: 1, mobile: false },
  { name: 'narrow', width: 390, height: 844, scale: 2, mobile: true },
];
const THEMES = ['light', 'dark'];
const saved = [];

async function setView(page, view, theme) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: view.width, height: view.height, deviceScaleFactor: view.scale, mobile: view.mobile,
  });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
}

// Every state is shot in both themes at both widths; `scrollTo` puts that section at the top of the viewport.
async function shootAll(page, name, { scrollTo = null, fullPage = false } = {}) {
  mkdirSync(OUT, { recursive: true });
  for (const view of VIEWS) {
    for (const theme of THEMES) {
      await setView(page, view, theme);
      await sleep(120);
      if (scrollTo) {
        await evaluate(page, `(() => { const el = document.querySelector(${q(scrollTo)});
          window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76); })()`);
      } else {
        await evaluate(page, 'window.scrollTo(0, 0)');
      }
      await sleep(80);
      // Asked twice at most: a screenshot whose answer went missing usually works the second time.
      const capture = () => timed(page, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage }, 30_000);
      const shot = await capture().catch(capture);
      const file = path.join(OUT, `${name}-${view.name}-${theme}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      saved.push(path.relative(path.join(HERE, '..', '..', '..'), file));
    }
  }
  await setView(page, VIEWS[0], 'light');
}

// --- QR codes: the SVG on the page must show exactly the modules qrcode-generator makes for `text` ---

async function checkQr(page, selector, expectedText) {
  const d = await evaluate(page, `document.querySelector(${q(`${selector} svg path`)})?.getAttribute('d') ?? null`);
  assert.ok(d, `${selector} has a QR code`);
  const qr = qrcode(0, 'M');
  qr.addData(expectedText, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const dark = new Set();
  for (const [, x, y, run] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(run); i++) dark.add(`${Number(x) + i - 4},${Number(y) - 4}`);
  }
  let expected = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) { expected++; assert.ok(dark.has(`${c},${r}`), `module ${c},${r} should be dark`); }
    }
  }
  assert.equal(dark.size, expected, 'no extra dark modules');
  const modules = await evaluate(page, `document.querySelector(${q(`${selector} svg`)}).dataset.modules`);
  assert.equal(Number(modules), n);
  return n;
}

// --- a new tab that records everything that matters ---

// Console lines, uncaught exceptions, pop-up dialogs and every request the page makes; plus, before the page's own
// scripts run (DevTools scripts aren't bound by the page's security policy), a recorder for security-policy
// violations and for any use of alert/confirm/prompt.
async function openPage(chrome, origin) {
  const page = await chrome.cdp.newPage();
  const consoleLines = [];
  const dialogs = [];
  const requests = [];
  page.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled') consoleLines.push({ level: m.params.type, text: m.params.args.map(a => a.value ?? a.description).join(' ') });
    if (m.method === 'Log.entryAdded') consoleLines.push({ level: m.params.entry.level, text: m.params.entry.text, source: m.params.entry.source, url: m.params.entry.url });
    if (m.method === 'Runtime.exceptionThrown') consoleLines.push({ level: 'error', text: m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text });
    if (m.method === 'Page.javascriptDialogOpening') dialogs.push(m.params);
    if (m.method === 'Network.requestWillBeSent') requests.push({ url: m.params.request.url, method: m.params.request.method, body: m.params.request.postData ?? '' });
  });
  await page.send('Network.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await chrome.cdp.send('Browser.grantPermissions', {
    origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  }).catch(() => {});
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__csp = []; window.__dialogs = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
      for (const f of ['alert', 'confirm', 'prompt']) window[f] = (...a) => { window.__dialogs.push(f); };`,
  });
  await setView(page, VIEWS[0], 'light');
  return { page, consoleLines, dialogs, requests };
}

// Chrome logs every 4xx answer as a network error. Those the walk-through asked for on purpose (on `allowed` paths)
// are fine; anything else, and anything the page itself logs or throws, is a failure. Returns the allowed ones' paths.
async function checkCleanConsole(page, { consoleLines, dialogs }, base, allowed) {
  assert.deepEqual(await evaluate(page, 'window.__csp'), [], 'no CSP violations');
  assert.deepEqual(await evaluate(page, 'window.__dialogs'), [], 'alert/confirm/prompt never used');
  assert.deepEqual(dialogs, []);
  const deliberate = (l) => l.source === 'network' && /status of (400|403)\b/.test(l.text) &&
    allowed.map(p => `${base}${p}`).includes(l.url);
  const bad = consoleLines.filter(l => ['error', 'warning', 'warn', 'assert'].includes(l.level) && !deliberate(l));
  assert.deepEqual(bad, [], 'no console errors or warnings');
  return consoleLines.filter(deliberate).map(l => l.url.slice(base.length)).sort();
}

// --- the walk-through ---

test('Setup page: every step in a real browser', { skip: !existsSync(CHROME) && 'Google Chrome is not installed', timeout: 240_000 }, async (t) => {
  await opaque.ready;
  const { controller, mock } = await createMockController({ test: true });
  let srv = await startSetupServer({ controller });
  const chrome = await launchChrome();
  t.after(async () => {
    await chrome.close().catch(() => {});
    await srv.close().catch(() => {});
  });

  const base = `http://127.0.0.1:${srv.port}`;
  const tab = await openPage(chrome, base);
  const { page, requests } = tab;

  await t.test('without the key, the page explains where to open Setup', async () => {
    await page.navigate(`${base}/`);
    assert.match(await text(page, 'h1'), /Open Setup from Perch/);
    assert.match(await text(page, 'main'), /menu bar/);
    await shootAll(page, '00-no-key');
  });

  await t.test('the page loads and shows the Mac\'s name and state', async () => {
    await page.navigate(srv.url);
    await waitFor(page, `document.getElementById('macName').textContent === 'amber-otter-4821'`);
    assert.equal(await text(page, '#statePillText'), 'Needs setup');
    assert.equal(await text(page, '#headVersion'), 'version 0.1.0');
    assert.equal(await visible(page, '#testBadge'), true);
    assert.equal(await evaluate(page, 'document.title'), 'Perch Setup · amber-otter-4821');
    assert.equal(await visible(page, '#pairLocked'), true, 'pairing waits for step 2');
    assert.equal(await evaluate(page, `document.getElementById('pairStartBtn').disabled`), true);
    await shootAll(page, '01-needs-setup', { fullPage: true });
  });

  await t.test('every control has a name a screen reader can read', async () => {
    const problems = await evaluate(page, `(() => {
      const bad = [];
      for (const el of document.querySelectorAll('button, input:not([type=hidden]):not([hidden]), select, a[href]')) {
        const name = el.getAttribute('aria-label') || (el.labels && [...el.labels].map(l => l.textContent).join(' ')) || el.textContent;
        if (!name || !name.trim()) bad.push(el.outerHTML.slice(0, 80));
      }
      for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) bad.push(img.outerHTML);
      return bad;
    })()`);
    assert.deepEqual(problems, []);
  });

  await t.test('step 1: permissions', async () => {
    await click(page, '#permScreen [data-open]');
    await until(() => mock.callsOf('requestPermission').some(c => c[1] === 'screen'), 'screen requested');
    mock.setPermissions({ screen: true });
    await waitFor(page, `document.querySelector('#permScreen [data-status]').textContent === '✓ Allowed'`);
    assert.equal(await visible(page, '#permScreen [data-open]'), false);
    assert.equal(await visible(page, '#permAccessibility [data-open]'), true);
    await click(page, '#permAccessibility [data-open]');
    await until(() => mock.callsOf('requestPermission').some(c => c[1] === 'accessibility'), 'accessibility requested');
    mock.setPermissions({ accessibility: true });
    await waitFor(page, `document.getElementById('numPerm').textContent === '✓'`);
  });

  await t.test('step 2: the authenticator app, with a real code', async () => {
    await click(page, '#totpStartBtn');
    await waitFor(page, `!document.getElementById('totpPending').hidden && !!document.querySelector('#totpQr svg')`);
    const secret = mock.pendingTotpSecret;
    assert.ok(secret, 'Perch made a secret');
    const n = await checkQr(page, '#totpQr', otpauthUri(secret, 'amber-otter-4821'));
    assert.ok(n >= 21);
    const shown = await text(page, '#totpSecret');
    assert.equal(shown.replace(/ /g, ''), base32(secret));
    assert.match(shown, /^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/, 'grouped in fours');
    assert.equal(await text(page, '#totpAccount'), 'Perch (amber-otter-4821)');
    assert.equal(await evaluate(page, 'document.activeElement.id'), 'totpCode', 'the code box has focus');
    await shootAll(page, '02-authenticator', { scrollTo: '#stepTotp' });

    await type(page, '#totpCode', '12');
    await press(page, 'Enter');
    await waitFor(page, `/6 digits/.test(document.getElementById('totpError').textContent)`, 'too-short message');
    assert.equal(mock.callsOf('totpConfirm').length, 0, 'not even sent');

    const right = totp(secret);
    const wrong = right.replace(/^./, (d) => String((Number(d) + 5) % 10));
    await type(page, '#totpCode', wrong);
    await press(page, 'Enter');
    await waitFor(page, `/didn't match/.test(document.getElementById('totpError').textContent)`, 'wrong-code message');

    await type(page, '#totpCode', `${right.slice(0, 3)} ${right.slice(3)}`); // with the space some apps show
    assert.equal(await value(page, '#totpCode'), right, 'spaces are dropped as you type');
    await click(page, '#totpConfirmBtn');
    await waitFor(page, `!document.getElementById('totpDone').hidden`, 'set up');
    assert.deepEqual(mock.callsOf('totpConfirm').at(-1), ['totpConfirm', right]);
    assert.deepEqual(mock.totpSecret, secret);
    assert.equal(await text(page, '#numTotp'), '✓');
    assert.equal(await visible(page, '#totpError'), false);
    assert.match(await text(page, '#totpOk'), /set up/);
  });

  await t.test('step 3: pairing shows a QR code, a link, a countdown and a warning', async () => {
    assert.equal(await visible(page, '#pairLocked'), false);
    await click(page, '#pairStartBtn');
    await waitFor(page, `!document.getElementById('pairActive').hidden && !!document.querySelector('#pairQr svg')`);
    const link = mock.raw.pairing.link;
    assert.match(link, /^https:\/\/just-rice\.github\.io\/perch\/connect\.html#pair=[A-Za-z0-9_-]{128}$/);
    await checkQr(page, '#pairQr', link);
    assert.equal(await value(page, '#pairLink'), link);
    assert.match(await text(page, '#pairActive .note.warn'), /Only scan this with your own device\. Never send this code or link to anyone/);
    assert.match(await text(page, '#pairActive'), /Face ID, Touch ID/);
    const first = await text(page, '#pairCountdown');
    assert.match(first, /^This code works for (10:00|9:5\d) more\.$/);
    // Whole seconds, rounded up, on a once-a-second tick: the first change can take up to two seconds to show.
    await waitFor(page, `document.getElementById('pairCountdown').textContent.trim() !== ${q(first)}`, 'the countdown moves', 3000);
    assert.match(await text(page, '#pairCountdown'), /^This code works for 9:5\d more\.$/);
    await click(page, '#pairCopyBtn');
    await waitFor(page, `document.getElementById('pairCopyStatus').textContent.length > 0`);
    assert.match(await text(page, '#pairCopyStatus'), /Copied|Selected/);
    await shootAll(page, '03-pairing', { scrollTo: '#stepPair' });

    await click(page, '#pairCancelBtn');
    await waitFor(page, `document.getElementById('pairActive').hidden`, 'pairing hidden after cancel');
    assert.equal(mock.callsOf('pairCancel').length, 1);
    assert.equal(await visible(page, '#pairOk'), false, 'cancelling is not a success');
  });

  await t.test('step 3: an expired code says so', async () => {
    await click(page, '#pairStartBtn');
    await waitFor(page, `!document.getElementById('pairActive').hidden`);
    mock.raw.pairing.expiresAt = Date.now() + 1500;
    mock.changed();
    await waitFor(page, `document.querySelector('.countdown').dataset.low === 'true'`, 'last-minute colour');
    await waitFor(page, `!document.getElementById('pairExpired').hidden && document.getElementById('pairActive').hidden`, 'expired', 5000);
    assert.match(await text(page, '#pairExpired'), /ran out/);
  });

  await t.test('step 3: Perch dropping the code itself is explained too', async () => {
    // Perch clears a code the moment it runs out, which can beat the page's own once-a-second check.
    await click(page, '#pairStartBtn');
    await waitFor(page, `!document.getElementById('pairActive').hidden`);
    assert.equal(await visible(page, '#pairExpired'), false, 'a new code hides the old message');
    mock.raw.pairing.expiresAt = Date.now() + 1500;
    mock.changed();
    await waitFor(page, `document.querySelector('.countdown').dataset.low === 'true'`, 'the page saw the new expiry');
    mock.raw.pairing = null;
    mock.changed();
    await waitFor(page, `document.getElementById('pairActive').hidden && !document.getElementById('pairExpired').hidden`, 'expired');
    assert.equal(await visible(page, '#pairGone'), false);

    // Three wrong proofs burn a code long before it runs out.
    await click(page, '#pairStartBtn');
    await waitFor(page, `!document.getElementById('pairActive').hidden`);
    assert.equal(await visible(page, '#pairExpired'), false);
    mock.raw.pairing = null;
    mock.note('pairing', 'Pairing link cancelled after 3 wrong proofs');
    await waitFor(page, `document.getElementById('pairActive').hidden && !document.getElementById('pairGone').hidden`, 'gone');
    assert.match(await text(page, '#pairGone'), /stopped working/);
    assert.equal(await visible(page, '#pairExpired'), false);
    assert.equal(await visible(page, '#pairOk'), false);
    assert.equal(await evaluate(page, `document.querySelector('#activityList li').dataset.tone`), 'bad');
  });

  await t.test('step 3: the page notices when a device finishes pairing', async () => {
    await click(page, '#pairStartBtn');
    await waitFor(page, `!document.getElementById('pairActive').hidden`);
    assert.equal(await visible(page, '#pairExpired'), false);
    assert.equal(await visible(page, '#pairGone'), false);
    mock.completePairing('Safari on iPhone');
    await waitFor(page, `/Safari on iPhone/.test(document.getElementById('pairOk').textContent)`, 'paired message');
    assert.equal(await visible(page, '#pairActive'), false);
    assert.equal(await visible(page, '#pairGone'), false, 'a finished pairing is not a dropped code');
    assert.equal(await text(page, '#numPair'), '✓');
    assert.equal(await text(page, '#statePillText'), 'Ready');
    assert.match(await text(page, '#deviceList'), /Safari on iPhone/);
  });

  await t.test('devices: rename, cancel, keep typing through live updates, remove, remove all', async () => {
    const work = mock.addDevice('Chrome on Windows');
    const ipad = mock.addDevice('iPad');
    await waitFor(page, `document.querySelectorAll('#deviceList .device').length === 3`);
    const row = (d) => `.device[data-id="${d.id}"]`;

    await click(page, `${row(work)} .device-buttons button:first-child`);
    await waitFor(page, `document.activeElement?.closest('${row(work)}') && document.activeElement.tagName === 'INPUT'`, 'rename box focused');
    await type(page, `${row(work)} input`, 'Work laptop');
    await press(page, 'Enter');
    await until(() => mock.callsOf('deviceRename').length === 1, 'rename sent');
    assert.deepEqual(mock.callsOf('deviceRename')[0], ['deviceRename', work.id, 'Work laptop']);
    await waitFor(page, `document.querySelector('${row(work)} .device-label').textContent === 'Work laptop'`);
    assert.equal(await visible(page, `${row(work)} input`), false);
    assert.equal(await focusedText(page), 'Rename', 'focus goes back to the Rename button');

    await click(page, `${row(ipad)} .device-buttons button:first-child`);
    await type(page, `${row(ipad)} input`, 'Something else');
    await press(page, 'Escape');
    await waitFor(page, `!document.querySelector('${row(ipad)} input')`, 'rename closed');
    assert.equal(await text(page, `${row(ipad)} .device-label`), 'iPad');
    assert.equal(mock.callsOf('deviceRename').length, 1, 'Escape saved nothing');

    // A live update arriving mid-rename must not wipe what's being typed.
    await click(page, `${row(ipad)} .device-buttons button:first-child`);
    await type(page, `${row(ipad)} input`, 'Kitchen iPad');
    mock.signIn({ viewer: 'Safari on iPhone', deviceId: mock.raw.devices[0].id });
    await waitFor(page, `!document.getElementById('sessionActive').hidden`, 'live update arrived');
    assert.equal(await value(page, `${row(ipad)} input`), 'Kitchen iPad');
    assert.equal(await evaluate(page, `document.activeElement === document.querySelector('${row(ipad)} input')`), true, 'still focused');
    await press(page, 'Enter');
    await waitFor(page, `document.querySelector('${row(ipad)} .device-label').textContent === 'Kitchen iPad'`);
    mock.raw.session = null;
    mock.changed();

    // Remove: Escape backs out, then confirm for real.
    await click(page, `${row(work)} .device-buttons button:last-child`);
    await waitFor(page, `!!document.querySelector('${row(work)} .confirm')`, 'confirmation shown');
    assert.match(await text(page, `${row(work)} .confirm p`), /Remove “Work laptop”\? It won't be able to connect any more\./);
    assert.equal(await focusedText(page), 'Keep it', 'the safe choice has focus');
    await shootAll(page, '05-confirm-remove-device', { scrollTo: '#devicesCard' });
    await press(page, 'Escape');
    await waitFor(page, `!document.querySelector('${row(work)} .confirm')`, 'confirmation closed');
    assert.equal(mock.callsOf('deviceRemove').length, 0);
    await click(page, `${row(work)} .device-buttons button:last-child`);
    await click(page, `${row(work)} .confirm .btn.danger`);
    await waitFor(page, `!document.querySelector('${row(work)}')`, 'row removed');
    assert.deepEqual(mock.callsOf('deviceRemove')[0], ['deviceRemove', work.id]);

    // Remove all.
    await click(page, '#removeAllBtn');
    await click(page, '#removeAllHost .confirm .btn.danger');
    await waitFor(page, `document.querySelectorAll('#deviceList .device').length === 0 && !document.getElementById('devicesEmpty').hidden`);
    assert.equal(mock.callsOf('devicesRemoveAll').length, 1);
    assert.equal(await text(page, '#statePillText'), 'Needs setup');
  });

  const passwords = [];
  const registerInPage = async () => {
    await click(page, '#backupSuggestBtn');
    await waitFor(page, `/^[a-z]+(-[a-z]+){4}$/.test(document.getElementById('backupPw').value)`, 'suggested password');
    const pw = await value(page, '#backupPw');
    passwords.push(pw);
    await click(page, '#backupSaveBtn');
    await waitFor(page, `!document.getElementById('backupOk').hidden`, 'saved', 20000);
    return pw;
  };

  await t.test('backup sign-in: the password is registered with OPAQUE in the page and never sent', async () => {
    assert.equal(await text(page, '#backupStatus'), 'Not set');
    assert.equal(await evaluate(page, `document.getElementById('backupOn').disabled`), true);
    await type(page, '#backupPw', 'short');
    assert.equal(await evaluate(page, `document.getElementById('backupHint').dataset.level`), 'short');
    await click(page, '#backupSaveBtn');
    await waitFor(page, `/Too short/.test(document.getElementById('backupError').textContent)`);
    await type(page, '#backupPw', 'amber-otter-4821-secret');
    await click(page, '#backupSaveBtn');
    await waitFor(page, `/Mac's name/.test(document.getElementById('backupError').textContent)`);
    assert.equal(mock.callsOf('backupRegisterStart').length, 0, 'nothing sent for a refused password');

    await click(page, '#backupShowBtn');
    assert.equal(await evaluate(page, `document.getElementById('backupPw').type`), 'text');
    await click(page, '#backupShowBtn');
    assert.equal(await evaluate(page, `document.getElementById('backupPw').type`), 'password');

    const pw = await registerInPage();
    assert.equal(await evaluate(page, `document.getElementById('backupPw').value`), '', 'cleared after saving');
    assert.equal(await evaluate(page, `document.getElementById('backupHint').dataset.level`), 'empty');
    assert.equal(mock.callsOf('backupRegisterStart').length, 1);
    assert.equal(mock.callsOf('backupRegisterFinish').length, 1);
    assert.match(await text(page, '#backupStatus'), /^Set on /);
    assert.equal(await evaluate(page, `document.getElementById('backupOn').checked`), true);
    assert.equal(await visible(page, '#backupRemoveHost'), true);
    assert.equal(await value(page, '#backupUsername'), 'amber-otter-4821');

    // The record really works: a full OPAQUE sign-in with the same password succeeds, a wrong one fails.
    const login = (password) => {
      const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
      const { serverLoginState, loginResponse } = opaque.server.startLogin({
        serverSetup: mock.opaqueServerSetup, userIdentifier: 'amber-otter-4821', registrationRecord: mock.backupRecord, startLoginRequest,
      });
      const fin = opaque.client.finishLogin({ clientLoginState, loginResponse, password });
      if (!fin) return null;
      const { sessionKey } = opaque.server.finishLogin({ serverLoginState, finishLoginRequest: fin.finishLoginRequest });
      return { client: fin.sessionKey, server: sessionKey };
    };
    const good = login(pw);
    assert.ok(good, 'the right password signs in');
    assert.equal(good.client, good.server, 'both sides agree on the session key');
    assert.equal(login(`${pw}x`), null, 'a wrong password does not');

    // The password itself never left the page.
    const sent = requests.filter(r => r.body || r.url.includes('?'));
    assert.ok(sent.some(r => r.url.endsWith('/api/backupRegisterStart')));
    for (const r of requests) {
      assert.ok(!r.body.includes(pw) && !decodeURIComponent(r.url).includes(pw), `password in ${r.method} ${r.url}`);
    }
    // But it was shown once, from Perch's suggestion, which is fine: that came from the Mac.
    assert.ok(mock.callsOf('suggestPassword').length >= 1);
  });

  await t.test('backup sign-in: on/off, a refusal, and removing it', async () => {
    await click(page, '#backupOn');
    await until(() => mock.callsOf('updateSettings').some(c => c[1].backupOn === false), 'turned off');
    await waitFor(page, `!document.getElementById('backupOn').checked && /Off/.test(document.getElementById('backupOnHint').textContent)`);
    mock.failNext('updateSettings', 'Perch couldn\'t turn that on right now.');
    await click(page, '#backupOn');
    await waitFor(page, `/couldn't turn that on/.test(document.getElementById('backupError').textContent)`);
    assert.equal(await evaluate(page, `document.getElementById('backupOn').checked`), false, 'the switch went back');
    await click(page, '#backupOn');
    await waitFor(page, `document.getElementById('backupOn').checked`);
    assert.equal(mock.raw.settings.backupOn, true);

    await click(page, '#backupRemoveBtn');
    await click(page, '#backupRemoveHost .confirm .btn.danger');
    await waitFor(page, `document.getElementById('backupStatus').textContent === 'Not set'`);
    assert.equal(mock.callsOf('backupRemove').length, 1);
    assert.equal(await evaluate(page, `document.getElementById('backupOn').disabled`), true);
  });

  await t.test('settings save as soon as they change', async () => {
    const lastPatch = () => mock.callsOf('updateSettings').at(-1)?.[1];
    await click(page, '#setLoginItem');
    await until(() => lastPatch()?.loginItem === false, 'login item off');
    await waitFor(page, `document.getElementById('settingsSaved').textContent === 'Saved.'`);
    await click(page, '#setLoginItem');
    await until(() => lastPatch()?.loginItem === true, 'login item on');

    await click(page, '#setKeepAwake');
    await until(() => lastPatch()?.keepAwake === false, 'keep awake off');

    await click(page, '#setPaused');
    await until(() => lastPatch()?.paused === true, 'paused');
    await waitFor(page, `document.getElementById('statePillText').textContent === 'Paused'`);
    await click(page, '#setPaused');
    await until(() => lastPatch()?.paused === false, 'resumed');

    for (const [v, expect] of [['30', 30], ['0', 0], ['120', 120]]) {
      await evaluate(page, `(() => { const s = document.getElementById('setIdle'); s.focus(); s.value = '${v}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await until(() => lastPatch()?.idleMinutes === expect, `idle ${v}`);
    }
    assert.equal(mock.raw.settings.idleMinutes, 120);

    await click(page, 'label.choice:has(input[value=sharp])');
    await until(() => lastPatch()?.quality === 'sharp', 'quality sharp');
    assert.equal(await evaluate(page, `document.querySelector('#setQuality input[value=sharp]').checked`), true);

    // A refused change goes back, with the reason.
    mock.failNext('updateSettings', 'That didn\'t work. Please try again.');
    await click(page, '#setKeepAwake');
    await waitFor(page, `/didn't work/.test(document.getElementById('settingsError').textContent)`);
    assert.equal(await evaluate(page, `document.getElementById('setKeepAwake').checked`), false);
    await click(page, '#setKeepAwake');
    await until(() => lastPatch()?.keepAwake === true, 'keep awake on');
    await waitFor(page, `document.getElementById('settingsError').hidden`);

    // macOS waiting for approval of the login item gets a hint.
    mock.setLoginItem({ on: false, status: 'requires-approval' });
    await waitFor(page, `!document.getElementById('loginItemHint').hidden`);
    assert.match(await text(page, '#loginItemHint'), /Login Items/);
    mock.setLoginItem({ on: true, status: 'enabled' });
    await waitFor(page, `document.getElementById('loginItemHint').hidden`);
  });

  await t.test('current session and Disconnect', async () => {
    const d = mock.addDevice('Safari on iPhone');
    mock.signIn({ viewer: 'Safari on iPhone', route: 'passkey', deviceId: d.id });
    await waitFor(page, `document.getElementById('statePillText').textContent === 'Connected to Safari on iPhone'`);
    assert.equal(await text(page, '#sessionViewer'), 'Safari on iPhone');
    assert.equal(await text(page, '#sessionRoute'), 'with a passkey');
    assert.match(await text(page, '#sessionSince'), /^today at .+\(less than a minute\)$/);
    await waitFor(page, `!document.querySelector('.device[data-id="${d.id}"] .device-now').hidden`, 'Connected now on the device');
    await click(page, '#disconnectBtn');
    await waitFor(page, `!document.getElementById('sessionNone').hidden`);
    assert.equal(mock.callsOf('disconnect').length, 1);
  });

  await t.test('recent activity with friendly times and Show more', async () => {
    mock.failedAttempt('Wrong 6-digit code from Firefox on Windows');
    await waitFor(page, `document.querySelector('#activityList li')?.dataset.tone === 'bad'`);
    assert.match(await text(page, '#activityList li:first-child'), /Wrong 6-digit code.*just now/);
    for (let i = 0; i < 10; i++) mock.note('sign-in', `Test sign-in ${i}`, new Date(Date.now() - (i + 1) * 3600_000).toISOString());
    await waitFor(page, `!document.getElementById('activityMoreBtn').hidden`);
    const total = mock.raw.activity.length;
    assert.equal(await evaluate(page, `document.querySelectorAll('#activityList li').length`), 8);
    await click(page, '#activityMoreBtn');
    await waitFor(page, `document.querySelectorAll('#activityList li').length === ${Math.min(total, 50)}`);
    assert.match(await text(page, '#activityList'), /hours? ago|today at|yesterday at/);
  });

  await t.test('About: updates', async () => {
    mock.setAvailableUpdate(null);
    await click(page, '#checkUpdatesBtn');
    await waitFor(page, `document.getElementById('updateStatus').textContent === 'You have the latest version.'`);
    assert.equal(await visible(page, '#updateBox'), false);
    // Offline, "no update" only means GitHub couldn't be asked.
    mock.setOffline(true);
    await waitFor(page, `document.getElementById('statePillText').textContent.startsWith('Offline')`, 'offline pill');
    await click(page, '#checkUpdatesBtn');
    await waitFor(page, `/Couldn't check/.test(document.getElementById('updateStatus').textContent)`, 'offline update check');
    mock.setOffline(false);
    mock.setAvailableUpdate({ version: '0.2.0', url: 'https://github.com/Just-Rice/perch/releases/tag/v0.2.0', notes: 'Smoother video on slow networks.' });
    await click(page, '#checkUpdatesBtn');
    await waitFor(page, `!document.getElementById('updateBox').hidden`);
    assert.equal(await text(page, '#updateVersion'), '0.2.0');
    assert.equal(await text(page, '#updateNotes'), 'Smoother video on slow networks.');
    assert.equal(await evaluate(page, `document.getElementById('updateLink').href`), 'https://github.com/Just-Rice/perch/releases/tag/v0.2.0');
    assert.equal(await evaluate(page, `document.getElementById('updateLink').rel`), 'noopener noreferrer');
    await click(page, '#installUpdateBtn');
    await until(() => mock.callsOf('installUpdate').length === 1, 'install requested');
    await waitFor(page, `/Updating/.test(document.getElementById('updateStatus').textContent)`);
    assert.equal(await evaluate(page, `document.getElementById('installUpdateBtn').disabled`), true);
  });

  await t.test('everything set up (screenshots)', async () => {
    mock.raw.devices = [];
    const day = 86_400_000;
    mock.addDevice('Safari on iPhone', { createdAt: new Date(Date.now() - 9 * day).toISOString(), lastUsedAt: new Date(Date.now() - 4 * 60_000).toISOString() });
    mock.addDevice('Chrome on the work laptop', { createdAt: new Date(Date.now() - 3 * day).toISOString(), lastUsedAt: new Date(Date.now() - day).toISOString() });
    mock.addDevice('iPad', { createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    mock.raw.activity = mock.raw.activity.slice(0, 6);
    await registerInPage();
    mock.signIn({ viewer: 'Safari on iPhone', route: 'passkey', deviceId: mock.raw.devices[0].id });
    await waitFor(page, `document.getElementById('statePillText').textContent === 'Connected to Safari on iPhone'`);
    // Leftover messages from the steps above would only clutter the picture.
    await evaluate(page, `document.getElementById('backupOk').hidden = true; document.getElementById('totpOk').hidden = true;
      document.getElementById('pairOk').hidden = true; document.getElementById('updateStatus').textContent = '';
      document.getElementById('installUpdateBtn').disabled = false; document.getElementById('settingsSaved').textContent = ''`);
    await shootAll(page, '04-all-set', { fullPage: true });
  });

  await t.test('About: a new name', async () => {
    const before = mock.raw.macName;
    await click(page, '#renameMacBtn');
    assert.match(await text(page, '#renameMacHost .confirm p'), /backup password is removed/);
    await click(page, '#renameMacHost .confirm .btn.primary');
    await until(() => mock.callsOf('newMacName').length === 1, 'new name');
    await waitFor(page, `document.getElementById('macName').textContent === ${q(mock.raw.macName)}`);
    assert.notEqual(mock.raw.macName, before);
    assert.equal(await text(page, '#backupStatus'), 'Not set');
    assert.equal(await text(page, '#backupUser'), mock.raw.macName);
  });

  await t.test('About: Start over, with an inline confirmation', async () => {
    await click(page, '#resetBtn');
    await waitFor(page, `!!document.querySelector('#resetHost .confirm')`);
    assert.match(await text(page, '#resetHost .confirm p'), /can't be undone/);
    assert.equal(await visible(page, '#resetBtn'), false);
    await shootAll(page, '05-confirm-start-over', { scrollTo: '#aboutCard .zone' });
    await click(page, '#resetHost .confirm .btn:not(.danger)');
    await waitFor(page, `!document.querySelector('#resetHost .confirm')`);
    assert.equal(await focusedText(page), 'Start over', 'focus back on the button');
    assert.equal(mock.callsOf('reset').length, 0);

    const before = mock.raw.macName;
    await click(page, '#resetBtn');
    await click(page, '#resetHost .confirm .btn.danger');
    await until(() => mock.callsOf('reset').length === 1, 'reset');
    await waitFor(page, `document.getElementById('macName').textContent === ${q(mock.raw.macName)}`);
    assert.notEqual(mock.raw.macName, before);
    assert.equal(await text(page, '#statePillText'), 'Needs setup');
    assert.equal(await visible(page, '#totpIdle'), true);
    assert.equal(await visible(page, '#pairLocked'), true);
    assert.equal(await visible(page, '#devicesEmpty'), true);
    assert.equal(await visible(page, '#activityEmpty'), true);
  });

  await t.test('About: Uninstall, with an inline confirmation', async () => {
    await click(page, '#uninstallBtn');
    await click(page, '#uninstallHost .confirm .btn:not(.danger)');
    assert.equal(mock.uninstalled, false);
    await click(page, '#uninstallBtn');
    await click(page, '#uninstallHost .confirm .btn.danger');
    await until(() => mock.uninstalled, 'uninstalled');
    await waitFor(page, `!document.getElementById('farewell').hidden && document.getElementById('aboutCard').hidden`);
    assert.equal(await text(page, '#statePillText'), 'Uninstalled');
    await shootAll(page, '06-uninstalled');
  });

  await t.test('no console errors, no security-policy violations, no pop-up dialogs', async () => {
    // The deliberate refusals: the page without its key (403), the wrong authenticator code and the two refusals the
    // mock was told to make (400).
    const refusals = await checkCleanConsole(page, tab, base, ['/', '/api/totpConfirm', '/api/updateSettings']);
    assert.deepEqual(refusals, ['/', '/api/totpConfirm', '/api/updateSettings', '/api/updateSettings'],
      'exactly the deliberate refusals');
    // Every request stayed on this Mac's Setup server.
    for (const r of requests) assert.ok(r.url.startsWith(`http://127.0.0.1:${srv.port}/`), r.url);
  });

  await t.test('losing Perch, then a restarted Perch with a new key', async () => {
    const page2 = await chrome.cdp.newPage();
    await page2.navigate(srv.url);
    await waitFor(page2, `document.getElementById('macName').textContent === ${q(mock.raw.macName)}`);
    const port = srv.port;
    await srv.close();
    await waitFor(page2, `/Can't reach Perch/.test(document.getElementById('banner').textContent) && !document.getElementById('banner').hidden`, 'lost banner', 15000);
    srv = await startSetupServer({ controller, port });
    await waitFor(page2, `/out of date/.test(document.getElementById('banner').textContent)`, 'stale banner', 15000);
    await chrome.cdp.send('Target.closeTarget', { targetId: page2.targetId });
  });

  console.log(`screenshots (${saved.length}):\n  ${saved.join('\n  ')}`);
});

// --- against the real host ---

const MAIN = path.join(HERE, '..', 'src', 'main.mjs');

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

// Starts src/main.mjs the way the Swift app does, but in test mode: a temporary home, secrets in a file there (never
// the Keychain), the local test broker, no update checks. This plays the app's end of the pipe: it says HELLO and
// records every command the host sends back, so nothing on this Mac is actually asked for anything.
async function startRealHost(brokerUrl) {
  const home = mkdtempSync(path.join(tmpdir(), 'perch-setup-host-'));
  const port = await freePort();
  const key = randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env, PERCH_TEST: '1', PERCH_HOME: home, PERCH_SECRETS: 'file', PERCH_BROKERS: brokerUrl,
      PERCH_SETUP_PORT: String(port), PERCH_SETUP_KEY: key, PERCH_ICE: 'none', PERCH_LOG: 'info',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const commands = [];
  const reader = new FrameReader();
  child.stdout.on('data', (d) => {
    for (const f of reader.push(d)) if (f.type === T.COMMAND) commands.push(JSON.parse(f.payload.toString('utf8')));
  });
  let log = '';
  child.stderr.on('data', (d) => { log = (log + d).slice(-100_000); });
  child.stdin.on('error', () => {});
  child.stdin.write(encodeJson(T.HELLO, {
    app: 'Perch', version: '0.1.0', ipc: 1, macos: '15.0', synthetic: true,
    permissions: { screen: true, accessibility: false },
    displays: [{ id: 1, name: 'Test Display', width: 1920, height: 1080, main: true }],
    loginItem: { on: false, status: 'not-registered' },
  }));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = async () => {
    child.stdin.end(); // the app going away is how the host is told to quit
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
    rmSync(home, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) { await stop(); throw new Error(`the host quit:\n${log.slice(-3000)}`); }
    const r = await fetch(`${base}/api/state`, { headers: { 'X-Perch-Key': key } }).catch(() => null);
    if (r?.ok) break;
    if (Date.now() > end) { await stop(); throw new Error(`Setup never answered:\n${log.slice(-3000)}`); }
    await sleep(100);
  }
  return { url: `${base}/?k=${key}`, base, key, commands, stop, get log() { return log; } };
}

test('Setup page against the real host process', { skip: !existsSync(CHROME) && 'Google Chrome is not installed', timeout: 120_000 }, async (t) => {
  const broker = await startBroker();
  const host = await startRealHost(broker.url);
  const chrome = await launchChrome();
  t.after(async () => {
    await chrome.close().catch(() => {});
    await host.stop().catch(() => {});
    await broker.close().catch(() => {});
  });
  const tab = await openPage(chrome, host.base);
  const { page } = tab;
  const state = async () => (await fetch(`${host.base}/api/state`, { headers: { 'X-Perch-Key': host.key } })).json();
  const command = (c, fields = {}) => until(
    () => host.commands.some(x => x.c === c && Object.entries(fields).every(([k, v]) => x[k] === v)),
    `the app was sent ${c} ${JSON.stringify(fields)}`);
  let idleRefused = false;

  await t.test('loads with the host\'s name, state and permissions', async () => {
    await page.navigate(host.url);
    const first = await state();
    await waitFor(page, `document.getElementById('macName').textContent === ${q(first.macName)}`, 'the Mac\'s name');
    assert.match(first.macName, /^[a-z]+-[a-z]+-\d{4}$/);
    await waitFor(page, `document.getElementById('statePillText').textContent === 'Needs setup'`, 'needs setup (broker connected)', 15000);
    assert.match(await text(page, '#stateText'), /authenticator app/);
    assert.equal(await text(page, '#permScreen [data-status]'), '✓ Allowed');
    assert.equal(await text(page, '#permAccessibility [data-status]'), 'Not allowed yet');
    await click(page, '#permAccessibility [data-open]');
    await command('request-permission', { which: 'accessibility' });
  });

  await t.test('authenticator app, with a code from the secret the page shows', async () => {
    await click(page, '#totpStartBtn');
    await waitFor(page, `!!document.querySelector('#totpQr svg') && document.getElementById('totpSecret').textContent.length > 20`);
    const secret = fromBase32((await text(page, '#totpSecret')).replace(/ /g, ''));
    assert.equal(secret.length, 20);
    await type(page, '#totpCode', totp(secret));
    await press(page, 'Enter');
    await waitFor(page, `!document.getElementById('totpDone').hidden`, 'set up');
    assert.equal((await state()).totp.set, true);
    assert.match(await text(page, '#stateText'), /pair/i);
  });

  await t.test('pairing link, QR code and countdown from the real host', async () => {
    await click(page, '#pairStartBtn');
    await waitFor(page, `!document.getElementById('pairActive').hidden && !!document.querySelector('#pairQr svg')`);
    const link = await value(page, '#pairLink');
    assert.match(link, /^https:\/\/just-rice\.github\.io\/perch\/connect\.html#pair=[A-Za-z0-9_-]{150}$/);
    assert.equal((await state()).pairing.link, link);
    await checkQr(page, '#pairQr', link);
    assert.match(await text(page, '#pairCountdown'), /^This code works for (10:00|9:5\d) more\.$/);
    await click(page, '#pairCancelBtn');
    await waitFor(page, `document.getElementById('pairActive').hidden`);
    assert.equal((await state()).pairing, null);
  });

  await t.test('backup password: OPAQUE in the page, accepted by the real host', async () => {
    await click(page, '#backupSuggestBtn');
    await waitFor(page, `/^[a-z]+(-[a-z]+){4}$/.test(document.getElementById('backupPw').value)`, 'suggested password');
    const pw = await value(page, '#backupPw');
    await click(page, '#backupSaveBtn');
    await waitFor(page, `!document.getElementById('backupOk').hidden`, 'saved', 20000);
    const s = await state();
    assert.deepEqual([s.backup.set, s.backup.on], [true, true]);
    assert.ok(!host.log.includes(pw), 'the password is nowhere in the host\'s log');
    await click(page, '#backupOn');
    await waitFor(page, `!document.getElementById('backupOn').checked`);
    assert.equal((await state()).backup.on, false);
    assert.equal(await visible(page, '#backupOk'), false, '"Saved… backup sign-in is on" is gone once it\'s off');
  });

  await t.test('settings reach the host and the app', async () => {
    // Both start on (the host told the app so when it said HELLO); switching them off must reach the app.
    await click(page, '#setKeepAwake');
    await command('keep-awake', { on: false });
    await click(page, '#setLoginItem');
    await command('login-item', { on: false });
    await click(page, 'label.choice:has(input[value=sharp])');
    await until(async () => (await state()).settings.quality === 'sharp', 'quality saved');
    await evaluate(page, `(() => { const s = document.getElementById('setIdle'); s.value = '30'; s.dispatchEvent(new Event('change')); })()`);
    await until(async () => (await state()).settings.idleMinutes === 30, 'idle 30 saved');
    // "Never": saved if the host supports it; otherwise the host's reason is shown and the choice goes back.
    await evaluate(page, `(() => { const s = document.getElementById('setIdle'); s.value = '0'; s.dispatchEvent(new Event('change')); })()`);
    await waitFor(page, `document.getElementById('settingsSaved').textContent === 'Saved.' || !document.getElementById('settingsError').hidden`, 'never: saved or refused');
    if (!(await visible(page, '#settingsError'))) {
      assert.equal((await state()).settings.idleMinutes, 0);
    } else {
      idleRefused = true;
      t.diagnostic(`the host refused idleMinutes 0 ("never"): ${await text(page, '#settingsError')}`);
      assert.equal(await value(page, '#setIdle'), '30', 'the choice went back');
      assert.equal((await state()).settings.idleMinutes, 30);
    }
  });

  await t.test('activity and the header follow the host', async () => {
    await waitFor(page, `document.querySelectorAll('#activityList li').length >= 3`);
    assert.match(await text(page, '#activityList'), /Authenticator app set up/);
    assert.match(await text(page, '#activityList'), /pairing link/i);
    await shootAll(page, '07-real-host', { fullPage: true });
  });

  await t.test('Start over on the real host', async () => {
    const before = (await state()).macName;
    await click(page, '#resetBtn');
    await click(page, '#resetHost .confirm .btn.danger');
    await until(async () => (await state()).macName !== before, 'a new name');
    const after = await state();
    await waitFor(page, `document.getElementById('macName').textContent === ${q(after.macName)}`);
    assert.equal(after.totp.set, false);
    assert.equal(after.backup.set, false);
    assert.equal(await visible(page, '#totpIdle'), true);
    assert.equal(await text(page, '#backupStatus'), 'Not set');
  });

  await t.test('no console errors, no security-policy violations, no pop-up dialogs', async () => {
    const refusals = await checkCleanConsole(page, tab, host.base, idleRefused ? ['/api/updateSettings'] : []);
    assert.deepEqual(refusals, idleRefused ? ['/api/updateSettings'] : []);
    assert.doesNotMatch(host.log, /uncaught exception|unhandled rejection|ERROR/);
  });
});

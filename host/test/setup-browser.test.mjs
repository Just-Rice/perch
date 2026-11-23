// The Control Center (the Setup page) in headless Chrome, against the mock controller (test/setup-mock-controller.mjs):
// every flow is walked through with real clicks and typing, the QR codes are checked module by module, the backup
// password is registered with OPAQUE in the page and then checked with a real OPAQUE sign-in here, and the page must
// finish with no console errors, no security-policy violations and no pop-up dialogs. Screenshots of each major
// state, light and dark, desktop and narrow, go to tests/e2e/out/setup/.
// A second, shorter walk-through runs the page against the real host (src/main.mjs in test mode, with the local test
// broker and a stand-in for roost.exe), to catch any difference between the mock and the real controller.
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
import { launchChrome, CHROME } from '../../tests/e2e/cdp.mjs';
import { startBroker } from '../../tests/e2e/broker.mjs';
import { CONNECT_URL } from '../../site/js/shared/proto.js';
import { startSetupServer } from '../src/setup-server.mjs';
import { totp, base32, otpauthUri, fromBase32 } from '../src/totp.mjs';
import { T, encodeJson, FrameReader } from '../src/ipc.mjs';
import { createMockController } from './setup-mock-controller.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'tests', 'e2e', 'out', 'setup');
// The vendored qrcode-generator is a classic browser script that defines a global. This package is all ES modules,
// so require() would load it as one and hand back an empty module; it runs in a sandbox of its own here instead.
const qrcode = vm.runInNewContext(
  `${readFileSync(path.join(HERE, '..', 'setup', 'vendor', 'qrcode.js'), 'utf8')}\n;qrcode`, {}, { filename: 'qrcode.js' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PAIR_LINK = (n) => new RegExp(`^${escapeRe(CONNECT_URL)}#pair=[A-Za-z0-9_-]{${n}}$`);

// --- a little page driver (its own, so no stray timers keep Node running) ---

// A DevTools call that fails after `ms` instead of waiting for ever. A reply can go missing (seen once when the
// computer went to sleep in the middle of a run), and a run that hangs says much less than one that fails.
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
// Its text as read, with runs of white space (from the HTML's line breaks) as one space.
const text = (page, sel) => evaluate(page, `document.querySelector(${q(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
// Shown: nothing hides it but the section it's in being another than the one on screen (the page shows one section
// of the Control Center at a time; anything else that's hidden uses the hidden attribute).
const visible = (page, sel) => evaluate(page, `(() => { const el = document.querySelector(${q(sel)});
  return !!el && !el.closest('[hidden]:not(.view)') && getComputedStyle(el).display !== 'none'; })()`);
const value = (page, sel) => evaluate(page, `document.querySelector(${q(sel)})?.value ?? null`);
const view = (page) => evaluate(page, `document.querySelector('.view:not([hidden])')?.id ?? null`);
const focusedText = (page) => evaluate(page, 'document.activeElement?.textContent.trim() || document.activeElement?.id || null');

// A real mouse click in the middle of the element, after checking nothing covers it.
async function click(page, selector) {
  const box = await evaluate(page, `(() => {
    const el = document.querySelector(${q(selector)});
    if (!el) return { missing: true };
    // As an in-page link would: show the section it's in.
    el.dispatchEvent(new CustomEvent('roost:reveal', { bubbles: true }));
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
  await evaluate(page, `(() => { const el = document.querySelector(${q(selector)});
    el.dispatchEvent(new CustomEvent('roost:reveal', { bubbles: true })); el.focus(); el.select?.(); })()`);
  await page.send('Input.insertText', { text: textToType });
}

const KEYS = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38 };
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

async function setView(page, view, theme, height = view.height) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: view.width, height, deviceScaleFactor: view.scale, mobile: view.mobile,
  });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
}

// Every state is shot in both themes at both widths; `scrollTo` puts that card at the top of the window. A full-page
// shot makes the window as tall as the page, so the sidebar, the tab bar and the background are drawn as they are
// seen. At every width the page must fit across: no sideways scrolling.
async function shootAll(page, name, { scrollTo = null, fullPage = false } = {}) {
  mkdirSync(OUT, { recursive: true });
  for (const view of VIEWS) {
    for (const theme of THEMES) {
      await setView(page, view, theme);
      await sleep(120);
      if (scrollTo) {
        await evaluate(page, `(() => { const el = document.querySelector(${q(scrollTo)});
          el.dispatchEvent(new CustomEvent('roost:reveal', { bubbles: true }));
          window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76); })()`);
      } else {
        await evaluate(page, 'window.scrollTo(0, 0)');
      }
      const wide = await evaluate(page, 'document.documentElement.scrollWidth - window.innerWidth');
      assert.ok(wide <= 0, `${name} at ${view.name} width scrolls sideways by ${wide}px`);
      if (fullPage) {
        const tall = await evaluate(page, 'document.documentElement.scrollHeight');
        await setView(page, view, theme, Math.min(Math.max(view.height, tall), 6000));
      }
      await sleep(fullPage ? 250 : 80);
      // Asked twice at most: a screenshot whose answer went missing usually works the second time.
      const capture = () => timed(page, 'Page.captureScreenshot', { format: 'png' }, 30_000);
      const shot = await capture().catch(capture);
      const file = path.join(OUT, `${name}-${view.name}-${theme}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      saved.push(path.relative(path.join(HERE, '..', '..'), file));
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
    if (m.method === 'Network.requestWillBeSent') requests.push({ url: m.params.request.url, method: m.params.request.method, body: m.params.request.postData ?? '', headers: m.params.request.headers });
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

test('Control Center: every flow in a real browser', { skip: !existsSync(CHROME) && 'Google Chrome is not installed', timeout: 300_000 }, async (t) => {
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
  const lastPatch = () => mock.callsOf('updateSettings').at(-1)?.[1];

  await t.test('without the key, the page explains where to open the Control Center', async () => {
    await page.navigate(`${base}/`);
    assert.match(await text(page, 'h1'), /Open (the Control Center|Setup) from (Roost|Perch)/);
    assert.match(await text(page, 'main'), /notification area|taskbar|menu bar/);
    await shootAll(page, '00-no-key');
  });

  await t.test('the page loads on Home, with the PC\'s name, its state and the setup steps', async () => {
    await page.navigate(srv.url);
    await waitFor(page, `document.getElementById('pcName').textContent === 'amber-otter-4821'`);
    assert.equal(await view(page), 'home');
    assert.equal(await text(page, '#statePillText'), 'Needs setup');
    assert.equal(await text(page, '#heroState'), 'Needs setup');
    assert.equal(await text(page, '#sidePcName'), 'amber-otter-4821');
    assert.equal(await text(page, '#headVersion'), 'Roost 0.1.0');
    assert.equal(await visible(page, '#testBadge'), true);
    assert.equal(await evaluate(page, 'document.title'), 'amber-otter-4821 · Roost Control Center');
    assert.equal(await visible(page, '#setupCard'), true);
    assert.equal(await text(page, '#stepsProgress'), '0 of 4 done');
    assert.equal(await evaluate(page, `document.getElementById('stepTotp').dataset.state`), 'current');
    assert.equal(await evaluate(page, `document.getElementById('stepPairBtn').disabled`), true, 'pairing waits for the app');
    assert.equal(await visible(page, '#stepAdmin'), true, 'Windows: admin control is offered');
    assert.equal(await visible(page, '#navHomeDot'), true);
    assert.equal(await visible(page, '#pairLocked'), true, 'pairing waits for the authenticator app');
    assert.equal(await evaluate(page, `document.getElementById('pairStartBtn').disabled`), true);
    // Every request carries the page's key, under Roost's name.
    assert.ok(requests.some(r => r.url.endsWith('/api/state') && r.headers['X-Roost-Key']), 'X-Roost-Key sent');
    await shootAll(page, '01-needs-setup', { fullPage: true });
  });

  await t.test('every control has a name a screen reader can read', async () => {
    const problems = await evaluate(page, `(() => {
      const bad = [];
      for (const el of document.querySelectorAll('button, input:not([type=hidden]):not([hidden]), select, a[href], summary')) {
        const name = el.getAttribute('aria-label') || (el.labels && [...el.labels].map(l => l.textContent).join(' ')) || el.textContent;
        if (!name || !name.trim()) bad.push(el.outerHTML.slice(0, 80));
      }
      for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) bad.push(img.outerHTML);
      for (const svg of document.querySelectorAll('svg.i')) if (!svg.closest('[aria-hidden=true]')) bad.push(svg.outerHTML.slice(0, 80));
      return bad;
    })()`);
    assert.deepEqual(problems, []);
  });

  await t.test('sections: the sidebar shows one at a time, by click, keyboard and address', async () => {
    await click(page, '.nav a[data-view=devices]');
    await waitFor(page, `document.querySelector('.view:not([hidden])').id === 'devices'`);
    assert.equal(await evaluate(page, `document.activeElement.id`), 'devicesTitle', 'reading starts at the new heading');
    assert.equal(await evaluate(page, `document.querySelector('.nav a[aria-current=page]').dataset.view`), 'devices');
    assert.equal(await evaluate(page, 'location.hash'), '#devices');
    // Arrow keys move between sections in the sidebar.
    await evaluate(page, `document.querySelector('.nav a[data-view=devices]').focus()`);
    await press(page, 'ArrowDown');
    assert.equal(await evaluate(page, `document.activeElement.dataset.view`), 'security');
    await press(page, 'Enter');
    await waitFor(page, `document.querySelector('.view:not([hidden])').id === 'security'`);
    // A link to a card in another section shows that section.
    await evaluate(page, `location.hash = '#adminCard'`);
    await waitFor(page, `document.querySelector('.view:not([hidden])').id === 'pc'`);
    await click(page, '.nav a[data-view=home]');
    await waitFor(page, `document.querySelector('.view:not([hidden])').id === 'home'`);
  });

  await t.test('Control admin apps: asked for, refused by Windows, then switched on', async () => {
    assert.equal(await text(page, '#adminChip'), 'Off');
    assert.match(await text(page, '#adminCard'), /Task Manager/);
    // The real app answers a moment later, after Windows' prompt: until then the switch shows what was asked for.
    const real = controller.elevation;
    controller.elevation = (on) => { mock.calls.push(['elevation', on]); return { ok: true }; };
    await click(page, '#setElevation');
    await until(() => mock.callsOf('elevation').length === 1, 'elevation asked for');
    assert.deepEqual(mock.callsOf('elevation')[0], ['elevation', true]);
    await waitFor(page, `document.getElementById('adminChip').textContent === 'Waiting for you'`);
    assert.equal(await evaluate(page, `document.getElementById('setElevation').checked`), true);
    assert.match(await text(page, '#adminStatus'), /Choose Yes/);
    await shootAll(page, '02-admin-waiting', { scrollTo: '#adminCard' });
    // The owner said No in Windows' prompt.
    mock.setApp({ elevationError: 'You chose No when Windows asked.' });
    await waitFor(page, `/chose No/.test(document.getElementById('adminError').textContent)`, 'the refusal');
    assert.equal(await evaluate(page, `document.getElementById('setElevation').checked`), false, 'the switch went back');
    assert.equal(await text(page, '#adminChip'), 'Off');
    controller.elevation = real;
    mock.setApp({ elevationError: null });

    // A refusal from Roost itself goes back too, with the reason.
    mock.failNext('elevation', 'Roost couldn\'t ask Windows right now.');
    await click(page, '#setElevation');
    await waitFor(page, `/couldn't ask Windows/.test(document.getElementById('adminError').textContent)`);
    assert.equal(await evaluate(page, `document.getElementById('setElevation').checked`), false);

    await click(page, '#setElevation');
    await waitFor(page, `document.getElementById('adminChip').textContent === 'On'`, 'on');
    assert.equal(mock.raw.app.elevatedTask, true);
    assert.match(await text(page, '#adminOk'), /administrator rights/);
    assert.equal(await text(page, '#numAdmin'), '✓');
    assert.equal(await visible(page, '#adminError'), false);
    // Not on Windows (or before the app has said): nothing to switch.
    mock.setApp({ os: 'macos' });
    await waitFor(page, `document.getElementById('setElevation').disabled && document.getElementById('stepAdmin').hidden`);
    mock.setApp({ os: 'windows' });
    await waitFor(page, `!document.getElementById('setElevation').disabled`);
  });

  await t.test('authenticator app: started from the Home stepper, with a real code', async () => {
    await click(page, '#stepTotpBtn');
    await waitFor(page, `!document.getElementById('totpPending').hidden && !!document.querySelector('#totpQr svg')`);
    assert.equal(await view(page), 'security', 'the stepper took us there');
    const secret = mock.pendingTotpSecret;
    assert.ok(secret, 'Roost made a secret');
    const n = await checkQr(page, '#totpQr', otpauthUri(secret, 'amber-otter-4821'));
    assert.ok(n >= 21);
    const shown = await text(page, '#totpSecret');
    assert.equal(shown.replace(/ /g, ''), base32(secret));
    assert.match(shown, /^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/, 'grouped in fours');
    assert.equal(await text(page, '#totpAccount'), 'Roost (amber-otter-4821)');
    assert.equal(await evaluate(page, 'document.activeElement.id'), 'totpCode', 'the code box has focus');
    await shootAll(page, '03-authenticator', { scrollTo: '#totpCard' });

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
    assert.equal(await evaluate(page, `document.getElementById('stepPair').dataset.state`), 'current');
  });

  await t.test('pairing: started from the stepper; a QR code, a link, a countdown and a warning', async () => {
    assert.equal(await visible(page, '#pairLocked'), false);
    await click(page, '.nav a[data-view=home]');
    await click(page, '#stepPairBtn');
    await waitFor(page, `!document.getElementById('pairActive').hidden && !!document.querySelector('#pairQr svg')`);
    assert.equal(await view(page), 'devices');
    const link = mock.raw.pairing.link;
    assert.match(link, PAIR_LINK(128));
    await checkQr(page, '#pairQr', link);
    assert.equal(await value(page, '#pairLink'), link);
    assert.match(await text(page, '#pairActive .note.warn'), /Only scan this with your own device\. Never send this code or link to anyone/);
    assert.match(await text(page, '#pairActive'), /Face ID, Touch ID, Windows Hello/);
    const first = await text(page, '#pairCountdown');
    assert.match(first, /^This code works for (10:00|9:5\d) more\.$/);
    // Whole seconds, rounded up, on a once-a-second tick: the first change can take up to two seconds to show.
    await waitFor(page, `document.getElementById('pairCountdown').textContent.trim() !== ${q(first)}`, 'the countdown moves', 3000);
    assert.match(await text(page, '#pairCountdown'), /^This code works for 9:5\d more\.$/);
    await click(page, '#pairCopyBtn');
    await waitFor(page, `document.getElementById('pairCopyStatus').textContent.length > 0`);
    assert.match(await text(page, '#pairCopyStatus'), /Copied|Selected: press Ctrl\+C/);
    await shootAll(page, '04-pairing', { scrollTo: '#pairCard' });

    await click(page, '#pairCancelBtn');
    await waitFor(page, `document.getElementById('pairActive').hidden`, 'pairing hidden after cancel');
    assert.equal(mock.callsOf('pairCancel').length, 1);
    assert.equal(await visible(page, '#pairOk'), false, 'cancelling is not a success');
  });

  await t.test('pairing: an expired code says so', async () => {
    await click(page, '#pairStartBtn');
    await waitFor(page, `!document.getElementById('pairActive').hidden`);
    mock.raw.pairing.expiresAt = Date.now() + 1500;
    mock.changed();
    await waitFor(page, `document.querySelector('#pairActive .countdown').dataset.low === 'true'`, 'last-minute colour');
    await waitFor(page, `!document.getElementById('pairExpired').hidden && document.getElementById('pairActive').hidden`, 'expired', 5000);
    assert.match(await text(page, '#pairExpired'), /ran out/);
  });

  await t.test('pairing: Roost dropping the code itself is explained too', async () => {
    // Roost clears a code the moment it runs out, which can beat the page's own once-a-second check.
    await click(page, '#pairStartBtn');
    await waitFor(page, `!document.getElementById('pairActive').hidden`);
    assert.equal(await visible(page, '#pairExpired'), false, 'a new code hides the old message');
    mock.raw.pairing.expiresAt = Date.now() + 1500;
    mock.changed();
    await waitFor(page, `document.querySelector('#pairActive .countdown').dataset.low === 'true'`, 'the page saw the new expiry');
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

  await t.test('pairing: the page notices when a device finishes', async () => {
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
    assert.equal(await text(page, '#navDeviceCount'), '1');
    assert.equal(await visible(page, '#navHomeDot'), false, 'nothing left that must be done');
  });

  await t.test('the setup steps: the optional ones can be hidden, and shown again', async () => {
    assert.match(await text(page, '#stepsProgress'), /^3 of 4 done · the rest is optional$/);
    assert.equal(await evaluate(page, `document.getElementById('stepRelay').dataset.state`), 'current');
    await click(page, '#stepsHideBtn');
    await waitFor(page, `document.getElementById('setupCard').hidden && !document.getElementById('stepsShowBtn').hidden`);
    assert.equal(await evaluate(page, 'document.activeElement.id'), 'stepsShowBtn');
    await click(page, '#stepsShowBtn');
    await waitFor(page, `!document.getElementById('setupCard').hidden`);
    assert.equal(await text(page, '#tileDevicesValue'), '1 paired');
    assert.equal(await text(page, '#tileSecurityValue'), 'Passkey + code');
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
    assert.equal(await visible(page, '#navHomeDot'), true);
  });

  await t.test('guest link: made, watched, copied and stopped', async () => {
    await evaluate(page, `(() => { const s = document.getElementById('guestMinutes'); s.value = '60'; })()`);
    await click(page, '#guestStartBtn');
    await waitFor(page, `!document.getElementById('guestActive').hidden`);
    assert.deepEqual(mock.callsOf('guestStart').at(-1), ['guestStart', 60]);
    assert.equal(await value(page, '#guestLink'), mock.raw.guest.link);
    assert.match(await text(page, '#guestCountdown'), /^The link works for (60:00|59:5\d) more\.$/);
    assert.equal(await text(page, '#guestWatching'), 'Nobody is watching yet.');
    mock.guestWatching(2);
    await waitFor(page, `document.getElementById('guestWatching').textContent === '2 people are watching now.'`);
    await click(page, '#guestCopyBtn');
    await waitFor(page, `/Copied|Ctrl\\+C/.test(document.getElementById('guestCopyStatus').textContent)`);
    await shootAll(page, '06-guest-link', { scrollTo: '#guestCard' });
    await click(page, '#guestStopBtn');
    await waitFor(page, `document.getElementById('guestActive').hidden && !document.getElementById('guestIdle').hidden`);
    assert.equal(mock.callsOf('guestStop').length, 1);
  });

  await t.test('sites that can sign in: adding one offers pairing for it; removing it', async () => {
    assert.match(await text(page, '#sitesList'), /· the official Roost site/);
    assert.equal(await visible(page, '#pairSiteLabel'), false, 'no choice with one site');
    await evaluate(page, `document.getElementById('sitesAdd').open = true`);
    await type(page, '#siteUrl', 'http://example.org/connect.html');
    await click(page, '#siteAddBtn');
    await waitFor(page, `/https/.test(document.getElementById('sitesError').textContent)`, 'refused');
    await type(page, '#siteUrl', 'https://roost.example.org/remote/');
    await click(page, '#siteAddBtn');
    await waitFor(page, `/Added roost\\.example\\.org/.test(document.getElementById('sitesOk').textContent)`, 'site added');
    await waitFor(page, `!document.getElementById('pairSiteLabel').hidden`, 'the site choice under Devices');
    await evaluate(page, `(() => { const s = document.getElementById('pairSite'); s.value = 'https://roost.example.org'; s.dispatchEvent(new Event('change')); })()`);
    await click(page, '#sitesList .site-row:last-child button');
    await waitFor(page, `!!document.querySelector('#sitesList .confirm')`, 'confirmation');
    await click(page, '#sitesList .confirm .btn.danger');
    await waitFor(page, `document.querySelectorAll('#sitesList .site-row').length === 1`, 'site removed');
    assert.deepEqual(mock.callsOf('siteRemove').at(-1), ['siteRemove', 'https://roost.example.org']);
    await waitFor(page, `document.getElementById('pairSiteLabel').hidden`, 'no choice again');
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
    await waitFor(page, `/PC's name/.test(document.getElementById('backupError').textContent)`);
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
    assert.ok(requests.some(r => r.url.endsWith('/api/backupRegisterStart')));
    for (const r of requests) {
      assert.ok(!r.body.includes(pw) && !decodeURIComponent(r.url).includes(pw), `password in ${r.method} ${r.url}`);
    }
    // But it was shown once, from Roost's suggestion, which is fine: that came from the PC.
    assert.ok(mock.callsOf('suggestPassword').length >= 1);
  });

  await t.test('backup sign-in: on/off, a refusal, and removing it', async () => {
    await click(page, '#backupOn');
    await until(() => mock.callsOf('updateSettings').some(c => c[1].backupOn === false), 'turned off');
    await waitFor(page, `!document.getElementById('backupOn').checked && /Off/.test(document.getElementById('backupOnHint').textContent)`);
    mock.failNext('updateSettings', 'Roost couldn\'t turn that on right now.');
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

  await t.test('relays: the TURN key, the Worker relay and its two backups', async () => {
    assert.equal(await text(page, '#relayChip'), 'Not set up');
    await type(page, '#relayKeyId', 'abc123');
    await type(page, '#relayToken', 'short');
    await click(page, '#relaySaveBtn');
    await waitFor(page, `/didn't accept/.test(document.getElementById('relayError').textContent)`, 'a bad key');
    await type(page, '#relayToken', 'a-long-enough-api-token');
    await click(page, '#relaySaveBtn');
    await waitFor(page, `document.getElementById('relayChip').textContent === 'Ready' && !document.getElementById('relayOk').hidden`);
    assert.deepEqual(mock.callsOf('relaySet').at(-1), ['relaySet', 'abc123', 'a-long-enough-api-token']);
    assert.equal(await value(page, '#relayToken'), '', 'the token isn\'t left in the page');
    assert.equal(await text(page, '#relaySaveBtn'), 'Check and replace');
    assert.equal(await text(page, '#numRelay'), '✓');

    assert.equal(await visible(page, '#relayBackups'), false, 'no backups before the relay');
    await click(page, '#workerRelaySaveBtn');
    await waitFor(page, `/Paste the relay/.test(document.getElementById('workerRelayError').textContent)`);
    await type(page, '#workerRelayUrl', 'https://roost-relay.jo.workers.dev');
    await click(page, '#workerRelaySaveBtn');
    await waitFor(page, `document.getElementById('workerRelayChip').textContent === 'Ready'`);
    assert.match(await text(page, '#workerRelayStatus'), /^Set up: https:\/\/roost-relay\.jo\.workers\.dev, since /);
    assert.equal(await visible(page, '#relayBackups'), true);
    await type(page, '#backupRelayUrl', 'https://jo.share.zrok.io');
    await click(page, '#backupRelaySaveBtn');
    await waitFor(page, `document.getElementById('backupRelayStatus').textContent === 'Set up: https://jo.share.zrok.io'`);
    assert.equal(await visible(page, '#backupRelayForm'), false);
    await type(page, '#tunnelUrl', 'https://not-local.example');
    await click(page, '#tunnelSaveBtn');
    await waitFor(page, `/127\\.0\\.0\\.1:8788/.test(document.getElementById('relayBackupsError').textContent)`, 'a tunnel elsewhere refused');
    await type(page, '#tunnelUrl', 'http://127.0.0.1:8788');
    await click(page, '#tunnelSaveBtn');
    await waitFor(page, `/^Set up: asks http:\\/\\/127\\.0\\.0\\.1:8788/.test(document.getElementById('tunnelStatus').textContent)`);
    assert.equal(await text(page, '#tileNetworkValue'), '2 relays ready');
    await shootAll(page, '07-network', { fullPage: true });

    await click(page, '#tunnelRemoveBtn');
    await click(page, '#tunnelRemoveHost .confirm .btn.danger');
    await waitFor(page, `!document.getElementById('tunnelForm').hidden`);
    await click(page, '#backupRelayRemoveBtn');
    await click(page, '#backupRelayRemoveHost .confirm .btn.danger');
    await waitFor(page, `!document.getElementById('backupRelayForm').hidden`);
    await click(page, '#workerRelayRemoveBtn');
    await click(page, '#workerRelayRemoveHost .confirm .btn.danger');
    await waitFor(page, `document.getElementById('relayBackups').hidden && document.getElementById('workerRelayChip').textContent === 'Not set up'`);
    await click(page, '#relayRemoveBtn');
    await click(page, '#relayRemoveHost .confirm .btn.danger');
    await waitFor(page, `document.getElementById('relayChip').textContent === 'Not set up'`);
    for (const m of ['relayRemove', 'workerRelayRemove', 'workerRelayBackupRemove', 'workerRelayTunnelRemove']) {
      assert.equal(mock.callsOf(m).length, 1, m);
    }
  });

  await t.test('settings save as soon as they change, wherever they are', async () => {
    await click(page, '#setLoginItem');
    await until(() => lastPatch()?.loginItem === false, 'start with Windows off');
    await waitFor(page, `document.getElementById('settingsSaved').textContent === 'Saved.'`);
    await click(page, '#setLoginItem');
    await until(() => lastPatch()?.loginItem === true, 'start with Windows on');

    await click(page, '#setKeepAwake');
    await until(() => lastPatch()?.keepAwake === false, 'keep awake off');

    // The hero's quick toggles.
    await click(page, '#setPaused');
    await until(() => lastPatch()?.paused === true, 'paused');
    await waitFor(page, `document.getElementById('statePillText').textContent === 'Paused'`);
    assert.equal(await text(page, '#heroState'), 'Paused');
    await click(page, '#setPaused');
    await until(() => lastPatch()?.paused === false, 'resumed');
    // A setting shown twice stays the same in both places.
    await click(page, '#quickCurtain');
    await until(() => lastPatch()?.curtain === true, 'curtain on from Home');
    await waitFor(page, `document.getElementById('setCurtain').checked`);
    await click(page, '#setLock');
    await until(() => lastPatch()?.lockOnDisconnect === true, 'lock on from This PC');
    await waitFor(page, `document.getElementById('quickLock').checked`);
    // Without Windows 10 2004 the curtain can't be left out of the picture: the switch is off, and says why.
    mock.setApp({ features: { curtain: false } });
    await click(page, '#quickCurtain');
    await until(() => lastPatch()?.curtain === false, 'curtain off');
    await waitFor(page, `document.getElementById('setCurtain').disabled && document.getElementById('quickCurtain').disabled && !document.getElementById('curtainHint').hidden`);
    assert.match(await text(page, '#curtainHint'), /Windows 10 version 2004 or later/);
    mock.setApp({ features: { curtain: true } });
    await waitFor(page, `!document.getElementById('setCurtain').disabled && document.getElementById('curtainHint').hidden`);

    for (const [v, expect] of [['30', 30], ['0', 0], ['120', 120]]) {
      await evaluate(page, `(() => { const s = document.getElementById('setIdle'); s.focus(); s.value = '${v}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await until(() => lastPatch()?.idleMinutes === expect, `idle ${v}`);
    }
    assert.equal(mock.raw.settings.idleMinutes, 120);

    // Sign-in: the 6-digit code can be switched off per way in.
    await click(page, '#setCodePasskey');
    await until(() => lastPatch()?.codeWithPasskey === false, 'code after a passkey off');
    await click(page, '#setCodePasskey');
    await until(() => lastPatch()?.codeWithPasskey === true, 'and on again');

    // Where "talk through your PC" plays: hidden until the app has listed the PC's sound outputs.
    assert.equal(await evaluate(page, `document.getElementById('micOutputRow').hidden`), true);
    mock.raw.audioOutputs = [{ uid: 'Realtek', name: 'Speakers (Realtek)', main: true }, { uid: 'VBCable', name: 'CABLE Input (VB-Audio Virtual Cable)', main: false }];
    mock.changed();
    await waitFor(page, `!document.getElementById('micOutputRow').hidden && document.getElementById('setMicOutput').options.length === 3`);
    assert.deepEqual(await evaluate(page, `[...document.getElementById('setMicOutput').options].map(o => o.textContent)`),
      ['Whatever your PC is playing sound on', 'Speakers (Realtek)', 'CABLE Input (VB-Audio Virtual Cable)']);
    await evaluate(page, `(() => { const s = document.getElementById('setMicOutput'); s.focus(); s.value = 'VBCable'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(() => lastPatch()?.micOutput === 'VBCable', 'the sound output saved');
    // Unplugged later: the choice still shows, marked as not connected.
    mock.raw.audioOutputs = [mock.raw.audioOutputs[0]];
    mock.changed();
    await waitFor(page, `[...document.getElementById('setMicOutput').options].some(o => o.textContent === 'An output that is not connected' && o.selected)`);

    // Sound while someone is connected: the two sliders, saved when let go, shown as percentages.
    const slide = (id, v) => evaluate(page, `(() => { const s = document.getElementById('${id}');
      s.dispatchEvent(new CustomEvent('roost:reveal', { bubbles: true })); s.focus(); s.value = '${v}';
      s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); s.blur(); })()`);
    assert.equal(await text(page, '#setSpeakersOut'), '100%');
    await slide('setSpeakers', 0);
    await until(() => lastPatch()?.macSpeakers === 0, 'PC speakers silent');
    assert.equal(await text(page, '#setSpeakersOut'), 'Silent');
    await slide('setStream', 150);
    await until(() => lastPatch()?.streamVolume === 1.5, 'sent at 150%');
    assert.match(await text(page, '#soundHint'), /afterwards your PC sounds as usual/);
    // A PC that can't turn its speakers down (before Windows 10 2004): that slider is off, and the note says why.
    mock.raw.soundTap = false;
    mock.changed();
    await waitFor(page, `document.getElementById('setSpeakers').disabled && /2004/.test(document.getElementById('soundHint').textContent)`);
    mock.raw.soundTap = true;
    mock.changed();
    await click(page, 'label.choice:has(input[value=sharp])');
    await until(() => lastPatch()?.quality === 'sharp', 'quality sharp');
    assert.equal(await evaluate(page, `document.querySelector('#setQuality input[value=sharp]').checked`), true);
    await click(page, 'label.choice:has(input[value=fast])');
    await until(() => lastPatch()?.quality === 'fast', 'quality fast');

    // A refused change goes back, with the reason, in that card.
    mock.failNext('updateSettings', 'That didn\'t work. Please try again.');
    await click(page, '#setKeepAwake');
    await waitFor(page, `/didn't work/.test(document.getElementById('settingsError').textContent)`);
    assert.equal(await evaluate(page, `document.getElementById('setKeepAwake').checked`), false);
    await click(page, '#setKeepAwake');
    await until(() => lastPatch()?.keepAwake === true, 'keep awake on');
    await waitFor(page, `document.getElementById('settingsError').hidden`);

    // Windows has Roost switched off as a startup app (Task Manager): a hint says where.
    mock.setLoginItem({ on: false, status: 'disabled' });
    await waitFor(page, `!document.getElementById('loginItemHint').hidden`);
    assert.match(await text(page, '#loginItemHint'), /Startup apps/);
    await shootAll(page, '08-this-pc', { fullPage: true });
    mock.setLoginItem({ on: true, status: 'enabled' });
    await waitFor(page, `document.getElementById('loginItemHint').hidden`);

    await click(page, '#setAutoUpdate');
    await until(() => lastPatch()?.autoUpdate === true, 'auto-update on');
  });

  await t.test('the current session, in the hero, and Disconnect', async () => {
    const d = mock.addDevice('Safari on iPhone');
    mock.signIn({ viewer: 'Safari on iPhone', route: 'passkey', deviceId: d.id });
    await waitFor(page, `document.getElementById('statePillText').textContent === 'Connected to Safari on iPhone'`);
    assert.equal(await evaluate(page, `document.getElementById('hero').dataset.tone`), 'live');
    assert.equal(await text(page, '#heroState'), 'Connected');
    assert.equal(await text(page, '#sessionViewer'), 'Safari on iPhone');
    assert.equal(await text(page, '#sessionRoute'), 'with a passkey');
    assert.match(await text(page, '#sessionSince'), /^today at .+\(less than a minute\)$/);
    await waitFor(page, `!document.querySelector('.device[data-id="${d.id}"] .device-now').hidden`, 'Connected now on the device');
    assert.match(await text(page, '#tileDevicesSub'), /Safari on iPhone is connected/);
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

  await t.test('About: this PC, and updates', async () => {
    assert.equal(await text(page, '#aboutVersion'), '0.1.0');
    assert.equal(await text(page, '#aboutWindows'), 'Windows 11 (build 22631)');
    assert.equal(await text(page, '#aboutArch'), '64-bit (x64)');
    assert.equal(await text(page, '#aboutEncoder'), mock.raw.app.features.encoder);
    mock.setApp({ osVersion: '10.0.19045', arch: 'arm64', features: { encoder: 'Media Foundation (Qualcomm)' } });
    await waitFor(page, `document.getElementById('aboutWindows').textContent === 'Windows 10 (build 19045)'`);
    assert.equal(await text(page, '#aboutArch'), 'Arm (ARM64)');
    assert.equal(await text(page, '#aboutEncoder'), 'Media Foundation (Qualcomm)');

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
    const url = 'https://github.com/faarisaahmed/roost/releases/tag/v0.2.0';
    mock.setAvailableUpdate({ version: '0.2.0', url, notes: 'Smoother video on slow networks.' });
    await click(page, '#checkUpdatesBtn');
    await waitFor(page, `!document.getElementById('updateBox').hidden`);
    assert.equal(await text(page, '#updateVersion'), '0.2.0');
    assert.equal(await text(page, '#updateNotes'), 'Smoother video on slow networks.');
    assert.equal(await evaluate(page, `document.getElementById('updateLink').href`), url);
    assert.equal(await evaluate(page, `document.getElementById('updateLink').rel`), 'noopener noreferrer');
    assert.equal(await visible(page, '#navAboutDot'), true);
    assert.equal(await text(page, '#tileUpdatesValue'), '0.2.0 available');
    // A link anywhere else is never offered.
    mock.raw.update = { ...mock.raw.update, url: 'https://evil.example/release' };
    mock.changed();
    await waitFor(page, `document.getElementById('updateLink').href === 'https://github.com/faarisaahmed/roost/releases'`);
    await click(page, '#installUpdateBtn');
    await until(() => mock.callsOf('installUpdate').length === 1, 'install requested');
    await waitFor(page, `/Updating/.test(document.getElementById('updateStatus').textContent)`);
    assert.equal(await evaluate(page, `document.getElementById('installUpdateBtn').disabled`), true);
  });

  await t.test('restart to finish updating', async () => {
    mock.raw.update = null;
    mock.changed();
    // The mock has no installed copy; play one by adding it to the state it sends.
    const state = controller.state;
    controller.state = () => ({ ...state(), restart: { version: '0.2.0', running: '0.1.0', sameSigner: true, autoAfterMs: 120000 } });
    mock.changed();
    await waitFor(page, `!document.getElementById('restartNote').hidden`);
    assert.equal(await text(page, '#restartVersion'), '0.2.0');
    assert.match(await text(page, '#restartDetail'), /still running Roost 0\.1\.0.*2 minutes/);
    assert.equal(await text(page, '#tileUpdatesValue'), 'Restart to finish');
    await click(page, '#restartBtn');
    await until(() => mock.callsOf('relaunch').length === 1, 'relaunch asked for');
    await waitFor(page, `/Restarting/.test(document.getElementById('restartStatus').textContent)`);
    controller.state = state;
    mock.changed();
    await waitFor(page, `document.getElementById('restartNote').hidden`);
  });

  await t.test('everything set up (screenshots)', async () => {
    mock.raw.devices = [];
    const day = 86_400_000;
    mock.addDevice('Safari on iPhone', { createdAt: new Date(Date.now() - 9 * day).toISOString(), lastUsedAt: new Date(Date.now() - 4 * 60_000).toISOString() });
    mock.addDevice('Chrome on the work laptop', { createdAt: new Date(Date.now() - 3 * day).toISOString(), lastUsedAt: new Date(Date.now() - day).toISOString() });
    mock.addDevice('iPad', { createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    mock.raw.activity = mock.raw.activity.slice(0, 6);
    mock.setApp({ osVersion: '10.0.22631', arch: 'x64', features: { encoder: 'Media Foundation (NVIDIA)' } });
    await registerInPage();
    mock.signIn({ viewer: 'Safari on iPhone', route: 'passkey', deviceId: mock.raw.devices[0].id });
    await waitFor(page, `document.getElementById('statePillText').textContent === 'Connected to Safari on iPhone'`);
    await click(page, '.nav a[data-view=home]');
    // Leftover messages from the steps above would only clutter the picture.
    await evaluate(page, `for (const id of ['backupOk', 'totpOk', 'pairOk', 'adminOk', 'sitesOk', 'relayOk', 'workerRelayOk', 'relayBackupsOk'])
      document.getElementById(id).hidden = true;
      document.getElementById('updateStatus').textContent = ''; document.getElementById('installUpdateBtn').disabled = false;
      for (const s of document.querySelectorAll('.saved')) s.textContent = ''`);
    await shootAll(page, '09-all-set', { fullPage: true });
    // All four done: the steps fold away, and the hero can bring them back.
    mock.raw.relay = { set: true, setAt: new Date().toISOString(), working: true };
    mock.changed();
    await waitFor(page, `document.getElementById('setupCard').hidden && document.getElementById('stepsShowBtn').textContent === 'Show the setup steps'`);
    await shootAll(page, '10-home-done');
    await shootAll(page, '11-devices', { scrollTo: '#devices' });
    await shootAll(page, '12-security', { scrollTo: '#security' });
    await shootAll(page, '13-about', { scrollTo: '#about' });
  });

  await t.test('About: a new name', async () => {
    const before = mock.raw.macName;
    await click(page, '#renamePcBtn');
    assert.match(await text(page, '#renamePcHost .confirm p'), /backup password is removed/);
    await click(page, '#renamePcHost .confirm .btn.primary');
    await until(() => mock.callsOf('newMacName').length === 1, 'new name');
    await waitFor(page, `document.getElementById('pcName').textContent === ${q(mock.raw.macName)}`);
    assert.notEqual(mock.raw.macName, before);
    assert.equal(await text(page, '#backupStatus'), 'Not set');
    assert.equal(await text(page, '#backupUser'), mock.raw.macName);
    assert.equal(await text(page, '#sidePcName'), mock.raw.macName);
  });

  await t.test('renaming from the hero: a name of your own, or a new made-up one', async () => {
    await click(page, '#nameBox summary');
    await waitFor(page, `document.getElementById('nameBox').open && document.activeElement.id === 'nameNew'`);
    await type(page, '#nameNew', 'x!');
    await click(page, '#nameSaveBtn');
    await waitFor(page, `/4 to 40 letters/.test(document.getElementById('nameError').textContent)`, 'a bad name refused');
    assert.equal(mock.callsOf('customMacName').length, 0);
    await type(page, '#nameNew', 'Jordan Desktop');
    await click(page, '#nameSaveBtn');
    await waitFor(page, `document.getElementById('pcName').textContent === 'jordan-desktop'`, 'the chosen name');
    assert.equal(await evaluate(page, `document.getElementById('nameBox').open`), false);
    assert.equal(await evaluate(page, 'document.activeElement.id'), 'pcName');
    await click(page, '#nameBox summary');
    await click(page, '#nameRandomBtn');
    await until(() => mock.callsOf('newMacName').length === 2, 'a made-up name again');
    await waitFor(page, `document.getElementById('pcName').textContent === ${q(mock.raw.macName)}`);
  });

  await t.test('About: choosing a name of your own, behind a "not recommended" warning', async () => {
    assert.equal(await evaluate(page, `document.getElementById('customNameBox').open`), false, 'tucked away until opened');
    await evaluate(page, `document.getElementById('customNameBox').open = true`);
    assert.match(await text(page, '#customNameBox summary'), /not recommended/);
    assert.match(await text(page, '#customNameBox p'), /easier to guess/);
    // Checked as typed: nothing reaches the PC until the name is usable.
    await type(page, '#customName', 'my.pc');
    await click(page, '#customNameBtn');
    await waitFor(page, `!document.getElementById('customNameError').hidden`);
    assert.match(await text(page, '#customNameError'), /4 to 40 letters or numbers/);
    const calls = mock.callsOf('customMacName').length;
    await type(page, '#customName', 'Room 204 PC');
    assert.equal(await visible(page, '#customNameError'), false, 'the message goes as soon as they type');
    await click(page, '#customNameBtn');
    await waitFor(page, `!!document.querySelector('#customNameHost .confirm')`);
    assert.match(await text(page, '#customNameHost .confirm p'), /room-204-pc.*easier to guess/);
    await click(page, '#customNameHost .confirm .btn.primary');
    await until(() => mock.callsOf('customMacName').length === calls + 1, 'custom name');
    await waitFor(page, `document.getElementById('pcName').textContent === 'room-204-pc'`);
    assert.equal(await text(page, '#backupUser'), 'room-204-pc');
    assert.equal(await evaluate(page, `document.getElementById('customNameBox').open`), false, 'closed again');
  });

  await t.test('About: Start over, with an inline confirmation', async () => {
    await click(page, '#resetBtn');
    await waitFor(page, `!!document.querySelector('#resetHost .confirm')`);
    assert.match(await text(page, '#resetHost .confirm p'), /can't be undone/);
    assert.equal(await visible(page, '#resetBtn'), false);
    await shootAll(page, '14-confirm-start-over', { scrollTo: '#zoneCard' });
    await click(page, '#resetHost .confirm .btn:not(.danger)');
    await waitFor(page, `!document.querySelector('#resetHost .confirm')`);
    assert.equal(await focusedText(page), 'Start over', 'focus back on the button');
    assert.equal(mock.callsOf('reset').length, 0);

    const before = mock.raw.macName;
    await click(page, '#resetBtn');
    await click(page, '#resetHost .confirm .btn.danger');
    await until(() => mock.callsOf('reset').length === 1, 'reset');
    await waitFor(page, `document.getElementById('pcName').textContent === ${q(mock.raw.macName)}`);
    assert.notEqual(mock.raw.macName, before);
    assert.equal(await view(page), 'home', 'back to Home and its setup steps');
    assert.equal(await visible(page, '#setupCard'), true);
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
    await waitFor(page, `!document.getElementById('farewell').hidden && document.getElementById('about').hidden`);
    assert.equal(await text(page, '#statePillText'), 'Uninstalled');
    await shootAll(page, '15-uninstalled');
  });

  await t.test('no console errors, no security-policy violations, no pop-up dialogs', async () => {
    // The deliberate refusals: the page without its key (403), the wrong authenticator code, a refused elevation,
    // two refused settings, a bad relay key, a site without https and a tunnel that isn't on this PC (400).
    const allowed = ['/', '/api/totpConfirm', '/api/updateSettings', '/api/elevation', '/api/relaySet', '/api/siteAdd',
      '/api/workerRelayTunnelSet'];
    const refusals = await checkCleanConsole(page, tab, base, allowed);
    assert.deepEqual(refusals, ['/', '/api/elevation', '/api/relaySet', '/api/siteAdd', '/api/totpConfirm',
      '/api/updateSettings', '/api/updateSettings', '/api/workerRelayTunnelSet'], 'exactly the deliberate refusals');
    // Every request stayed on this PC's Control Center server.
    for (const r of requests) assert.ok(r.url.startsWith(`http://127.0.0.1:${srv.port}/`), r.url);
  });

  await t.test('losing Roost, then a restarted Roost with a new key', async () => {
    const page2 = await chrome.cdp.newPage();
    await page2.navigate(srv.url);
    await waitFor(page2, `document.getElementById('pcName').textContent === ${q(mock.raw.macName)}`);
    const port = srv.port;
    await srv.close();
    await waitFor(page2, `/Can't reach Roost/.test(document.getElementById('banner').textContent) && !document.getElementById('banner').hidden`, 'lost banner', 15000);
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

// Starts src/main.mjs the way roost.exe does, but in test mode: a temporary home, secrets in a file there (never
// DPAPI), the local test broker, no update checks. This plays the app's end of the pipe: it says HELLO as roost.exe
// would and records every command the host sends back, so nothing on this computer is actually asked for anything.
async function startRealHost(brokerUrl) {
  const home = mkdtempSync(path.join(tmpdir(), 'roost-setup-host-'));
  const port = await freePort();
  const key = randomBytes(32).toString('base64url');
  const env = { TEST: '1', HOME: home, SECRETS: 'file', BROKERS: brokerUrl, SETUP_PORT: String(port), SETUP_KEY: key, ICE: 'none', LOG: 'info' };
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, ...Object.fromEntries(Object.entries(env).map(([k, v]) => [`ROOST_${k}`, v])) },
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
    app: 'Roost', version: '0.1.0', ipc: 1, os: 'windows', osVersion: '10.0.22631', arch: 'x64', synthetic: true,
    soundTap: true, permissions: { screen: true, accessibility: true, elevated: false },
    displays: [{ id: 1, name: 'Test Display', x: 0, y: 0, width: 1920, height: 1080, main: true }],
    loginItem: { on: false, status: 'not-registered' },
    features: { curtain: true, encoder: 'OpenH264', elevatedTask: false },
  }));
  const event = (obj) => child.stdin.write(encodeJson(T.EVENT, obj));
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
    const r = await fetch(`${base}/api/state`, { headers: { 'X-Roost-Key': key } }).catch(() => null);
    if (r?.ok) break;
    if (Date.now() > end) { await stop(); throw new Error(`the Control Center never answered:\n${log.slice(-3000)}`); }
    await sleep(100);
  }
  return { url: `${base}/?k=${key}`, base, key, commands, event, stop, get log() { return log; } };
}

test('Control Center against the real host process', { skip: !existsSync(CHROME) && 'Google Chrome is not installed', timeout: 120_000 }, async (t) => {
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
  const state = async () => (await fetch(`${host.base}/api/state`, { headers: { 'X-Roost-Key': host.key } })).json();
  const command = (c, fields = {}) => until(
    () => host.commands.some(x => x.c === c && Object.entries(fields).every(([k, v]) => x[k] === v)),
    `the app was sent ${c} ${JSON.stringify(fields)}`);

  await t.test('loads with the host\'s name, state and Windows details', async () => {
    await page.navigate(host.url);
    const first = await state();
    await waitFor(page, `document.getElementById('pcName').textContent === ${q(first.macName)}`, 'the PC\'s name');
    assert.match(first.macName, /^[a-z]+-[a-z]+-\d{4}$/);
    await waitFor(page, `document.getElementById('statePillText').textContent === 'Needs setup'`, 'needs setup (broker connected)', 15000);
    assert.match(await text(page, '#stateText'), /authenticator app/);
    assert.equal(await text(page, '#aboutWindows'), 'Windows 11 (build 22631)');
    assert.equal(await text(page, '#aboutEncoder'), 'OpenH264');
    assert.equal(await text(page, '#adminChip'), 'Off');
  });

  await t.test('Control admin apps: the app is asked, and its answer shows', async () => {
    await click(page, '#setElevation');
    await command('elevation', { on: true });
    await waitFor(page, `document.getElementById('adminChip').textContent === 'Waiting for you'`);
    // Windows said no: the switch goes back, with the reason.
    host.event({ e: 'elevation', ok: false, elevated: false, task: false, error: 'You chose No when Windows asked.' });
    await waitFor(page, `/chose No/.test(document.getElementById('adminError').textContent) && !document.getElementById('setElevation').checked`, 'refused');
    await click(page, '#setElevation');
    await until(() => host.commands.filter(x => x.c === 'elevation').length === 2, 'asked again');
    host.event({ e: 'elevation', ok: true, elevated: true, task: true });
    await waitFor(page, `document.getElementById('adminChip').textContent === 'On' && document.getElementById('setElevation').checked`, 'on');
    assert.equal((await state()).app.elevatedTask, true);
  });

  await t.test('the PC’s name can be changed right in the hero: one of your own, or a new made-up one', async () => {
    const before = (await state()).macName;
    await click(page, '#nameBox summary');
    await type(page, '#nameNew', 'x!');
    await click(page, '#nameSaveBtn');
    await waitFor(page, `/4 to 40 letters/.test(document.getElementById('nameError').textContent)`, 'a bad name refused');
    await type(page, '#nameNew', 'Jordan Desktop');
    await click(page, '#nameSaveBtn');
    await waitFor(page, `document.getElementById('pcName').textContent === 'jordan-desktop'`, 'the chosen name');
    assert.equal((await state()).macName, 'jordan-desktop');
    assert.equal(await evaluate(page, `document.getElementById('nameBox').open`), false);
    await click(page, '#nameBox summary');
    await click(page, '#nameRandomBtn');
    await until(async () => /^[a-z]+-[a-z]+-\d{4}$/.test((await state()).macName), 'a made-up name again');
    assert.notEqual((await state()).macName, before);
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
    await waitFor(page, `/pair/i.test(document.getElementById('stateText').textContent)`, 'next: pair');
  });

  await t.test('pairing link, QR code and countdown from the real host', async () => {
    await click(page, '#pairStartBtn');
    await waitFor(page, `!document.getElementById('pairActive').hidden && !!document.querySelector('#pairQr svg')`);
    const link = await value(page, '#pairLink');
    assert.match(link, PAIR_LINK(150));
    assert.equal((await state()).pairing.link, link);
    await checkQr(page, '#pairQr', link);
    assert.match(await text(page, '#pairCountdown'), /^This code works for (10:00|9:5\d) more\.$/);
    await click(page, '#pairCancelBtn');
    await waitFor(page, `document.getElementById('pairActive').hidden`);
    assert.equal((await state()).pairing, null);
  });

  await t.test('sites that can sign in: the official one is fixed; adding one offers pairing for it; removing it', async () => {
    const official = new URL(CONNECT_URL).origin;
    assert.ok((await state()).sites.filter(x => x.builtIn).map(x => x.origin).includes(official));
    assert.match(await text(page, '#sitesList'), new RegExp(`${escapeRe(new URL(official).host)} · the official Roost site`));
    assert.equal(await page.eval(`document.getElementById('pairSiteLabel').hidden`), true, 'no choice with one site');
    assert.equal(await page.eval(`document.querySelectorAll('#sitesList button').length`), 0, 'the official site has no Remove');
    await page.eval(`document.getElementById('sitesAdd').open = true`);
    // Refused: not https, an IP address, a site already there.
    for (const [bad, why] of [['http://example.org/connect.html', /https/], ['https://192.168.1.5/x', /domain name/],
      [`${official}/other/`, /already/]]) {
      await page.eval(`document.getElementById('siteUrl').value = ''`);
      await type(page, '#siteUrl', bad);
      await click(page, '#siteAddBtn');
      await waitFor(page, `${why}.test(document.getElementById('sitesError').textContent)`, `refusal for ${bad}`);
    }
    await page.eval(`document.getElementById('siteUrl').value = ''`);
    await type(page, '#siteUrl', 'https://roost.example.org/remote/');
    await click(page, '#siteAddBtn');
    await waitFor(page, `/Added roost\\.example\\.org/.test(document.getElementById('sitesOk').textContent)`, 'site added');
    const added = (await state()).sites.find(x => !x.builtIn);
    assert.deepEqual([added.origin, added.url], ['https://roost.example.org', 'https://roost.example.org/remote/connect.html']);
    // Pairing can now be made for either site.
    await waitFor(page, `!document.getElementById('pairSiteLabel').hidden`, 'the site choice under Devices');
    await page.eval(`(() => { const s = document.getElementById('pairSite'); s.value = 'https://roost.example.org'; s.dispatchEvent(new Event('change')); })()`);
    await click(page, '#pairStartBtn');
    await waitFor(page, `!document.getElementById('pairActive').hidden`);
    assert.match(await value(page, '#pairLink'), /^https:\/\/roost\.example\.org\/remote\/connect\.html#pair=[A-Za-z0-9_-]{150}$/);
    // Removing the site (after confirming) cancels its pairing link too.
    await click(page, '#sitesList .site-row:last-child button');
    await waitFor(page, `!!document.querySelector('#sitesList .confirm')`, 'confirmation');
    await click(page, '#sitesList .confirm .btn.danger');
    await waitFor(page, `document.querySelectorAll('#sitesList .site-row').length === 1`, 'site removed');
    const after = await state();
    assert.equal(after.sites.length, after.sites.filter(x => x.builtIn).length);
    assert.equal(after.pairing, null);
    await waitFor(page, `document.getElementById('pairSiteLabel').hidden`, 'no choice again');
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
    await click(page, '#quickCurtain');
    await until(async () => (await state()).settings.curtain === true, 'curtain saved');
    await evaluate(page, `(() => { const s = document.getElementById('setIdle'); s.value = '30'; s.dispatchEvent(new Event('change')); })()`);
    await until(async () => (await state()).settings.idleMinutes === 30, 'idle 30 saved');
    // "Never" is saved like any other choice.
    await evaluate(page, `(() => { const s = document.getElementById('setIdle'); s.value = '0'; s.dispatchEvent(new Event('change')); })()`);
    await until(async () => (await state()).settings.idleMinutes === 0, 'idle never saved');
    assert.equal(await visible(page, '#settingsError'), false, 'no error for "Never"');
  });

  await t.test('activity and the hero follow the host', async () => {
    await click(page, '.nav a[data-view=home]');
    await waitFor(page, `document.querySelectorAll('#activityList li').length >= 3`);
    assert.match(await text(page, '#activityList'), /Authenticator app set up/);
    assert.match(await text(page, '#activityList'), /pairing link/i);
    await shootAll(page, '16-real-host', { fullPage: true });
  });

  await t.test('Start over on the real host', async () => {
    const before = (await state()).macName;
    await click(page, '#resetBtn');
    await click(page, '#resetHost .confirm .btn.danger');
    await until(async () => (await state()).macName !== before, 'a new name');
    const after = await state();
    await waitFor(page, `document.getElementById('pcName').textContent === ${q(after.macName)}`);
    assert.equal(after.totp.set, false);
    assert.equal(after.backup.set, false);
    assert.equal(await visible(page, '#totpIdle'), true);
    assert.equal(await text(page, '#backupStatus'), 'Not set');
  });

  await t.test('no console errors, no security-policy violations, no pop-up dialogs', async () => {
    // The deliberate refusals: three addresses the sites section must not accept.
    const refusals = await checkCleanConsole(page, tab, host.base, ['/api/siteAdd']);
    assert.deepEqual(refusals, ['/api/siteAdd', '/api/siteAdd', '/api/siteAdd']);
    assert.doesNotMatch(host.log, /uncaught exception|unhandled rejection|ERROR/);
  });
});

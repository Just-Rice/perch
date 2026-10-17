// Helpers for the website's browser tests: the static server, the local message broker and a headless Chrome whose
// every tab and frame has a virtual passkey authenticator (tests/e2e/cdp.mjs), so nothing ever reaches the real
// Touch ID or iCloud Keychain. Clicks, taps and keys are real input events (CDP Input.*), so the page sees exactly
// what a person would produce. Screenshots go to tests/e2e/out/site/ (git-ignored).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, collectConsole, autoVirtualAuthenticator } from '../../e2e/cdp.mjs';
import { startBroker } from '../../e2e/broker.mjs';
import { serveSite } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.resolve(HERE, '../../e2e/out/site');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const DESKTOP = { width: 1280, height: 800, mobile: false };
export const PHONE = { width: 390, height: 844, mobile: true };
export const PHONE_LANDSCAPE = { width: 844, height: 390, mobile: true };

export const UA = {
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
};

// Everything one test file needs. close() stops all of it (Chrome, server, broker) and deletes the profile.
export async function startStack({ broker = true } = {}) {
  mkdirSync(OUT, { recursive: true });
  const server = await serveSite();
  const brk = broker ? await startBroker() : null;
  const profile = mkdtempSync(path.join(tmpdir(), 'perch-site-chrome-'));
  const launch = () => launchChrome({
    userDataDir: profile,
    // Raw host addresses instead of mDNS names in ICE candidates: the fake Mac (werift) and Chrome are on this Mac.
    extraArgs: ['--mute-audio', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  // Now and then (a busy machine) Chrome answers on its DevTools port before its socket accepts connections: try again.
  // launchChrome leaves that Chrome running when it fails, so stop it (it is the only one using this profile) first.
  let chrome;
  try {
    chrome = await launch();
  } catch {
    try { execFileSync('pkill', ['-f', `--user-data-dir=${profile}`]); } catch {}
    await sleep(1500);
    chrome = await launch();
  }
  const targets = new Map(); // targetId -> {session, info}: every tab, popup and out-of-process frame
  const auth = await autoVirtualAuthenticator(chrome.cdp, {
    onSession: (session, info) => targets.set(info.targetId, { session, info }),
  });
  chrome.cdp.on(m => {
    if (m.method === 'Target.targetInfoChanged') {
      const t = targets.get(m.params.targetInfo.targetId);
      if (t) t.info = m.params.targetInfo;
    } else if (m.method === 'Target.detachedFromTarget' && m.params.targetId) {
      targets.delete(m.params.targetId);
    }
  });
  await chrome.cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  const port = server.port;
  return {
    server, broker: brk, chrome, cdp: chrome.cdp, auth, targets, port,
    pages: new Set(),
    // For test.afterEach: a test that failed half-way leaves its tab open otherwise, and old tabs playing video slow
    // down every test after it.
    async closePages() {
      for (const p of [...this.pages]) await p.close();
    },
    // localhost, not 127.0.0.1: an IP address can't be a passkey domain (RP ID).
    base: `http://localhost:${port}/`,
    otherOrigin: `http://127.0.0.1:${port}/`,
    connectUrl(params = {}) {
      const q = new URLSearchParams({ test: '1', ...(brk ? { brokers: brk.url } : {}), ...params });
      return `http://localhost:${port}/connect.html?${q}`;
    },
    async close() {
      // Bounded: Chrome may close its DevTools socket without answering Browser.close.
      await Promise.race([chrome.close(), sleep(8000)]);
      if (chrome.proc.exitCode === null) chrome.proc.kill('SIGKILL');
      await server.close();
      await brk?.close();
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}

// Opens a new tab at `url` with a viewport, colour scheme and (optionally) another user agent.
export async function openPage(stack, url, { view = DESKTOP, dark = false, ua, name = 'page' } = {}) {
  const s = await stack.cdp.newPage();
  const logs = collectConsole(s);
  await s.send('Page.enable');
  // Report Content-Security-Policy violations loudly, from every frame of the page, before any page script runs.
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source:
    "addEventListener('securitypolicyviolation', e => console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI), true);" });
  if (ua) await s.send('Emulation.setUserAgentOverride', { userAgent: ua, platform: /Windows/.test(ua) ? 'Win32' : 'iPhone' });
  const page = new Page(stack, s, logs, name);
  stack.pages?.add(page);
  await page.setView({ view, dark });
  if (url) await page.goto(url);
  return page;
}

export class Page {
  constructor(stack, session, logs, name) {
    Object.assign(this, { stack, s: session, logs, name });
    this.shots = [];
    this.view = DESKTOP;
    this.dark = false;
  }

  // Every DevTools call gets a time limit: a page that stopped drawing frames can leave Input.* or a screenshot
  // waiting forever, and a clear "timed out" error beats a test run that never ends.
  send(m, p, timeoutMs = 20000) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${m} timed out`)), timeoutMs); });
    return Promise.race([this.s.send(m, p), timeout]).finally(() => clearTimeout(timer));
  }
  eval(expr, opts) { return evaluate(this.s, expr, opts); }

  async goto(url) {
    await this.s.navigate(url);
  }

  async setView({ view = this.view, dark = this.dark } = {}) {
    this.view = view;
    this.dark = dark;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: view.width, height: view.height, deviceScaleFactor: view.mobile ? 2 : 1, mobile: !!view.mobile,
    });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: !!view.mobile, maxTouchPoints: view.mobile ? 5 : 1 });
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  }

  // Polls a page expression until it is truthy; resolves to its value.
  async waitFor(expr, { timeoutMs = 15000, what = expr } = {}) {
    const until = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try { last = await this.eval(expr, { timeoutMs: 5000 }); } catch (e) { last = e.message; }
      if (last && !(typeof last === 'string' && last.startsWith('page exception'))) return last;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
      await sleep(100);
    }
  }

  // Which sign-in screen is showing ('home', 'code', …), 'viewer', 'boot' or null.
  screen() {
    return this.eval(`(() => {
      if (!document.getElementById('viewer')?.hidden) return 'viewer';
      if (!document.getElementById('boot')?.hidden) return 'boot';
      const s = [...document.querySelectorAll('#main > .screen')].find(x => !x.hidden);
      return s ? s.id.slice(2) : null;
    })()`);
  }

  waitScreen(name, opts = {}) {
    return this.waitFor(`(() => { const want = ${JSON.stringify([].concat(name))};
      if (!document.getElementById('viewer')?.hidden) return want.includes('viewer') && 'viewer';
      const s = [...document.querySelectorAll('#main > .screen')].find(x => !x.hidden);
      return s && want.includes(s.id.slice(2)) && s.id.slice(2); })()`, { what: `screen ${name}`, ...opts });
  }

  text(selector) {
    return this.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
  }

  async center(selector) {
    const r = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }; })()`);
    if (!r) throw new Error(`no element ${selector}`);
    return r;
  }

  // A real mouse click in the middle of the element (or at x, y).
  async click(selector, { x, y, button = 'left', clickCount = 1 } = {}) {
    if (selector) ({ x, y } = await this.center(selector));
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y, { button, clickCount });
    await this.mouse('mouseReleased', x, y, { button, clickCount });
  }

  mouse(type, x, y, { button = 'none', clickCount = 0, buttons, modifiers = 0, deltaX, deltaY } = {}) {
    const bits = { none: 0, left: 1, right: 2, middle: 4 };
    return this.send('Input.dispatchMouseEvent', {
      type, x, y, button, clickCount, modifiers,
      buttons: buttons ?? (type === 'mouseReleased' ? 0 : bits[button] ?? 0),
      ...(deltaX !== undefined ? { deltaX, deltaY } : {}),
    });
  }

  // touches: [{x, y, id}] — one call per touchStart / touchMove / touchEnd.
  touch(type, touches) {
    return this.send('Input.dispatchTouchEvent', { type, touchPoints: touches.map(t => ({ x: t.x, y: t.y, id: t.id ?? 0, radiusX: 4, radiusY: 4, force: 1 })) });
  }

  async tap(x, y, holdMs = 40) {
    await this.touch('touchStart', [{ x, y }]);
    await sleep(holdMs);
    await this.touch('touchEnd', []);
  }

  async key(key, code, { modifiers = 0, text, keyCode } = {}) {
    const common = { key, code, modifiers, windowsVirtualKeyCode: keyCode ?? vk(key, code), nativeVirtualKeyCode: keyCode ?? vk(key, code) };
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...common, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }

  keyDown(key, code, modifiers = 0) {
    return this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, modifiers, windowsVirtualKeyCode: vk(key, code) });
  }

  keyUp(key, code, modifiers = 0) {
    return this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: vk(key, code) });
  }

  type(text) { return this.send('Input.insertText', { text }); }

  async shot(name) {
    await sleep(120); // let transitions and fonts settle
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    this.shots.push(path.relative(path.resolve(OUT, '../../../..'), file));
    return file;
  }

  // The same screen in light and dark, on a desktop and on a phone; puts the view back afterwards.
  async shotAll(name, { views = { desktop: DESKTOP, phone: PHONE }, schemes = ['light', 'dark'] } = {}) {
    const keep = { view: this.view, dark: this.dark };
    for (const [vname, view] of Object.entries(views)) {
      for (const scheme of schemes) {
        await this.setView({ view, dark: scheme === 'dark' });
        await this.shot(`${name}-${vname}-${scheme}`);
      }
    }
    await this.setView(keep);
  }

  // Console errors, uncaught exceptions and CSP violations seen so far (minus ones a test expects).
  problems(allow = []) {
    return this.logs.filter(l => /\[console\.error\]|\[exception\]|\[log\.error|CSP violation|Refused to/.test(l))
      .filter(l => !allow.some(re => re.test(l)));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stack.pages?.delete(this);
    await Promise.race([this.stack.cdp.send('Target.closeTarget', { targetId: this.s.targetId }).catch(() => {}), sleep(5000)]);
  }
}

// Windows virtual key codes for the keys the tests press (CDP needs them for keydown to have a keyCode).
function vk(key, code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit\d$/.test(code)) return code.charCodeAt(5);
  return { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    ShiftLeft: 16, ControlLeft: 17, AltLeft: 18, MetaLeft: 91, ControlRight: 17, MetaRight: 92, Delete: 46 }[code] ?? 0;
}

// Runtime.evaluate with a time limit. (tests/e2e/cdp.mjs's session.eval leaves a 60-second timer behind on every
// call, which keeps the test process alive for a minute after the last one; this clears its timer.)
export async function evaluate(session, expression, { awaitPromise = true, userGesture = false, timeoutMs = 30000 } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('eval timeout: ' + expression.slice(0, 80))), timeoutMs);
  });
  try {
    const r = await Promise.race([
      session.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture }), timeout]);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page exception: ' + (d.exception?.description || d.exception?.value || d.text));
    }
    return r.result.value;
  } finally {
    clearTimeout(timer);
  }
}

// The session of another tab or out-of-process frame whose URL matches, once it shows up.
export async function targetMatching(stack, pred, { timeoutMs = 10000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    for (const t of stack.targets.values()) if (pred(t.info)) return t.session;
    if (Date.now() > until) throw new Error('no such target: ' + [...stack.targets.values()].map(t => `${t.info.type} ${t.info.url}`).join(', '));
    await sleep(100);
  }
}

// Evaluates in a same-process frame of `page` (any origin, even an opaque one) through an isolated world.
export async function evalInFrame(page, urlPred, expression) {
  const { frameTree } = await page.send('Page.getFrameTree');
  const all = [];
  const walk = n => { all.push(n.frame); for (const c of n.childFrames || []) walk(c); };
  walk(frameTree);
  const f = all.find(fr => urlPred(fr.url));
  if (!f) return { missing: true, frames: all.map(fr => fr.url) };
  const { executionContextId } = await page.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'perch-test' });
  const r = await page.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
  return r.result.value;
}

export { sleep };

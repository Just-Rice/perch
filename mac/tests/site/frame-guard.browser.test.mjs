// The connect page refuses to run inside another website's frame, and keeps working in Perch's own about:blank and
// blob: tabs (js/blank.js, the front page, About:Blank Lab-style launchers). Headless Chrome, real clicks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openPage, targetMatching, evalInFrame, evaluate, sleep } from './lib/browser.mjs';

const STATE = `(() => {
  const boot = document.getElementById('boot'), home = document.getElementById('s-home');
  if (!boot || !home) return null;
  const st = { refused: boot.classList.contains('refused'), home: !home.hidden && !document.getElementById('app').hidden,
    text: document.getElementById('bootText').textContent.trim(), link: document.querySelector('#bootText a')?.href || null,
    origin: window.origin, top: window.top === window };
  return st.refused || st.home ? st : null;
})()`;

let stack;
test.before(async () => { stack = await startStack({ broker: false }); });
test.after(async () => { await stack?.close(); });
test.afterEach(async () => { await stack?.closePages(); });

// Polls a frame (same-process, or out-of-process in its own target) until the guard has decided.
async function frameState(page, urlPart, { timeoutMs = 10000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let st = await evalInFrame(page, u => u.includes(urlPart), STATE).catch(() => null);
    if (st?.missing || st === null) {
      for (const t of stack.targets.values()) {
        if (t.info.type !== 'iframe') continue;
        const inner = t.info.url.includes(urlPart) ? await evaluate(t.session, STATE).catch(() => null)
          : await evalInFrame(t.session, u => u.includes(urlPart), STATE).catch(() => null);
        if (inner && !inner.missing) { st = inner; break; }
      }
    }
    if (st && !st.missing) return st;
    if (Date.now() > until) throw new Error(`frame ${urlPart} never decided (${JSON.stringify(st)})`);
    await sleep(150);
  }
}

test('opened directly: runs', async () => {
  const page = await openPage(stack, stack.connectUrl());
  const st = await page.waitFor(STATE);
  assert.equal(st.refused, false);
  assert.equal(st.home, true);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('inside a frame on another website: refused, with a link to open Perch directly', async () => {
  const src = stack.connectUrl();
  const page = await openPage(stack, `${stack.otherOrigin}__test/framer.html?src=${encodeURIComponent(src)}`);
  const st = await frameState(page, '/connect.html');
  assert.equal(st.refused, true, JSON.stringify(st));
  assert.equal(st.home, false);
  assert.match(st.text, /^Perch can't run inside another website\. Open it directly:/);
  assert.equal(st.link, src.split('#')[0]);
  await page.shot('frame-guard-refused-desktop-light');
  await page.close();
});

test('inside our own frame that is itself inside another website: refused (the guard checks every level)', async () => {
  const inner = `${stack.base}__test/inner.html?src=${encodeURIComponent(stack.connectUrl())}`;
  const page = await openPage(stack, `${stack.otherOrigin}__test/framer.html?src=${encodeURIComponent(inner)}`);
  const st = await frameState(page, '/connect.html');
  assert.equal(st.refused, true, JSON.stringify(st));
  await page.close();
});

test('inside a sandboxed frame (opaque origin), even on our own site: refused', async () => {
  const page = await openPage(stack, `${stack.base}__test/sandboxed.html?src=${encodeURIComponent(stack.connectUrl())}`);
  const st = await frameState(page, '/connect.html');
  assert.equal(st.origin, 'null');
  assert.equal(st.refused, true, JSON.stringify(st));
  await page.close();
});

async function popupAfter(fn) {
  const before = new Set([...stack.targets.keys()]);
  await fn();
  return targetMatching(stack, info => info.type === 'page' && !before.has(info.targetId) && info.url === 'about:blank' || false)
    .catch(async () => targetMatching(stack, info => info.type === 'page' && !before.has(info.targetId)));
}

// The popup's frame is same-origin, so its document can be read from the tab itself.
const FRAMED = `(() => { const f = document.querySelector('iframe'); const d = f?.contentDocument; if (!d) return null;
  const s = (${STATE.replace(/document/g, 'd').replace('window.origin', 'f.contentWindow.origin').replace('window.top === window', 'f.contentWindow.top === f.contentWindow')});
  return s ? { ...s, tab: location.href, title: document.title } : null; })()`;

async function waitFramed(session) {
  for (let i = 0; i < 100; i++) {
    const st = await evaluate(session, FRAMED).catch(() => null);
    if (st) return st;
    await sleep(100);
  }
  throw new Error('framed page never decided');
}

test('"Open in an about:blank tab" on the connect page: works in the new tab', async () => {
  const page = await openPage(stack, stack.connectUrl());
  await page.waitFor(STATE);
  const popup = await popupAfter(() => page.click('#btnBlank'));
  const st = await waitFramed(popup);
  assert.equal(st.tab, 'about:blank');
  assert.equal(st.refused, false, JSON.stringify(st));
  assert.equal(st.home, true);
  assert.equal(st.top, false);
  assert.match(await page.text('#blankStatus'), /Opened Perch in a new about:blank tab/);
  await page.close();
  await stack.cdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
});

test('"Open in an about:blank tab" on the front page: works too', async () => {
  const page = await openPage(stack, stack.base);
  const popup = await popupAfter(() => page.click('#openBlank'));
  const st = await waitFramed(popup);
  assert.equal(st.tab, 'about:blank');
  assert.equal(st.title, 'Perch');
  assert.equal(st.refused, false, JSON.stringify(st));
  assert.equal(st.home, true);
  assert.deepEqual(page.problems(), []);
  await page.close();
  await stack.cdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
});

test('an About:Blank Lab-style launcher (DOM-built sandboxed frame with allow-same-origin): works', async () => {
  const page = await openPage(stack, `${stack.base}__test/lab.html`);
  const popup = await popupAfter(() => page.eval(`openLab(${JSON.stringify(stack.connectUrl())})`, { userGesture: true }));
  const st = await waitFramed(popup);
  assert.equal(st.refused, false, JSON.stringify(st));
  assert.equal(st.home, true);
  await page.close();
  await stack.cdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
});

test('a blob: tab holding the frame: works', async () => {
  const page = await openPage(stack, `${stack.base}__test/lab.html`);
  const before = new Set([...stack.targets.keys()]);
  await page.eval(`openBlob(${JSON.stringify(stack.connectUrl())})`, { userGesture: true });
  const popup = await targetMatching(stack, info => info.type === 'page' && !before.has(info.targetId) && info.url.startsWith('blob:'));
  const st = await waitFramed(popup);
  assert.match(st.tab, /^blob:http:\/\/localhost:/);
  assert.equal(st.refused, false, JSON.stringify(st));
  assert.equal(st.home, true);
  await page.close();
  await stack.cdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
});

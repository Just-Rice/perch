// Demo mode (connect.html?demo=1 on localhost): the viewer with a canvas test picture and no network. Real mouse,
// touch and keyboard events (CDP Input.*) must turn into exactly the protocol's input messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openPage, DESKTOP, PHONE, PHONE_LANDSCAPE, UA, sleep } from './lib/browser.mjs';
import { toDisplay } from '../../site/js/viewer/coords.js';

let stack;
test.before(async () => { stack = await startStack({ broker: false }); });
test.after(async () => { await stack?.close(); });
test.afterEach(async () => { await stack?.closePages(); });

const demoUrl = (params = {}) => `${stack.base}connect.html?${new URLSearchParams({ demo: '1', ...params })}`;

// Messages the viewer sent since `from` (an index into the demo's list).
const messages = (page, from = 0) => page.eval(`window.__perch.demoMessages.slice(${from})`);
const count = page => page.eval('window.__perch.demoMessages.length');
const without = (list, ...types) => list.filter(m => !types.includes(m.t));

async function geometry(page) {
  return page.eval(`(() => { const b = document.getElementById('surface').getBoundingClientRect(); const v = document.getElementById('video');
    return { box: { left: b.left, top: b.top, width: b.width, height: b.height }, vw: v.videoWidth, vh: v.videoHeight,
      view: window.__perch.viewer.view }; })()`);
}

// Where the page should say (x, y) is on the Mac, from its own geometry: an independent check of the mapping.
async function expected(page, x, y) {
  const g = await geometry(page);
  return toDisplay(x, y, g.box, g.vw, g.vh, g.view);
}

async function ready(page) {
  await page.waitFor(`(() => { const v = document.getElementById('video'); return !document.getElementById('viewer').hidden && v.videoWidth > 0 && v.readyState >= 2; })()`,
    { what: 'the demo picture' });
  const t0 = await page.eval(`document.getElementById('video').currentTime`);
  await sleep(400);
  assert.ok(await page.eval(`document.getElementById('video').currentTime`) > t0, 'the picture is moving');
}

test('desktop: the viewer shows the test picture, with the toolbar', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  assert.equal(await page.eval(`document.getElementById('app').hidden`), true, 'sign-in screens are gone');
  assert.equal(await page.eval(`getComputedStyle(document.getElementById('video')).objectFit`), 'contain');
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('tb-on')`), true);
  assert.equal(await page.text('#tbName'), 'demo-mac-0000');
  assert.equal(await page.eval(`document.getElementById('tbDisplayWrap').hidden`), false, 'two displays: a picker');
  assert.equal(await page.eval(`document.getElementById('tbKeyboard').hidden`), true, 'no keyboard button on a desktop');
  assert.equal(await page.eval(`document.getElementById('kbdFab').hidden`), true, 'no floating keyboard button on a desktop');
  assert.equal(await page.eval(`document.getElementById('swapWrap').hidden`), true, 'this Chrome says Mac: no Ctrl/⌘ swap');
  await page.shot('viewer-demo-toolbar-desktop');
  // The toolbar tucks itself away, and comes back when the mouse goes near the top.
  await page.mouse('mouseMoved', 640, 500);
  await page.waitFor(`!document.getElementById('viewer').classList.contains('tb-on')`, { timeoutMs: 8000, what: 'toolbar hidden' });
  await page.shot('viewer-demo-clean-desktop');
  await page.mouse('mouseMoved', 640, 10);
  await page.waitFor(`document.getElementById('viewer').classList.contains('tb-on')`, { what: 'toolbar back' });
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('desktop: mouse moves, clicks, double clicks, right clicks and scrolling', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  let n = await count(page);
  await page.mouse('mouseMoved', 640, 400);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).some(m => m.t === 'm')`, { what: 'a pointer move' });
  const move = (await messages(page, n)).find(m => m.t === 'm');
  const want = await expected(page, 640, 400);
  assert.equal(move.channel, 'pointer');
  assert.deepEqual([move.x, move.y], [want.x, want.y]);
  assert.ok(Math.abs(move.x - 0.5) < 0.001 && Math.abs(move.y - 0.5) < 0.001, 'the middle of the window is the middle of the Mac');

  // A click near the left edge of the picture (inside the letterbox bars' neighbour).
  const g = await geometry(page);
  const pic = { x: g.box.left + (g.box.width - g.vw * Math.min(g.box.width / g.vw, g.box.height / g.vh)) / 2 };
  const cx = pic.x + 30, cy = 300;
  n = await count(page);
  await page.click(null, { x: cx, y: cy });
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`, { what: 'button down and up' });
  const w = await expected(page, cx, cy);
  const clicks = (await messages(page, n)).filter(m => m.t === 'b');
  assert.deepEqual(clicks.map(({ channel, t, b, d, n: c, x, y }) => ({ channel, t, b, d, n: c, x, y })), [
    { channel: 'input', t: 'b', b: 0, d: true, n: 1, x: w.x, y: w.y },
    { channel: 'input', t: 'b', b: 0, d: false, n: 1, x: w.x, y: w.y },
  ]);

  // Double click: the second press carries count 2.
  n = await count(page);
  await page.click(null, { x: 700, y: 450, clickCount: 1 });
  await page.click(null, { x: 700, y: 450, clickCount: 2 });
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 4`, { what: 'double click' });
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'b').map(m => `${m.d ? '↓' : '↑'}${m.n}`), ['↓1', '↑1', '↓2', '↑2']);

  // Right click: button 2, and the browser's own menu doesn't open.
  n = await count(page);
  const menuPrevented = page.eval(`new Promise(r => document.getElementById('surface').addEventListener('contextmenu', e => r(e.defaultPrevented), { once: true }))`);
  await page.click(null, { x: 500, y: 300, button: 'right' });
  assert.equal(await menuPrevented, true);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`);
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'b').map(m => [m.b, m.d]), [[2, true], [2, false]]);

  // Scrolling: pixel deltas, one message per frame.
  n = await count(page);
  await page.mouse('mouseWheel', 640, 400, { deltaX: 0, deltaY: 120 });
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).some(m => m.t === 'w')`, { what: 'a scroll' });
  const wheel = (await messages(page, n)).find(m => m.t === 'w');
  assert.equal(wheel.channel, 'input');
  assert.equal(wheel.dy, 120);
  assert.equal(wheel.dx, 0);
  assert.ok(Math.abs(wheel.x - 0.5) < 0.001);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('desktop: keys go to the Mac with the protocol\'s code, key and modifier bits; focus loss releases them', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  await page.click(null, { x: 640, y: 400 });
  let n = await count(page);
  await page.key('a', 'KeyA', { text: 'a' });
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 2`, { what: 'key a' });
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'k').map(({ t, c, k, d, m }) => ({ t, c, k, d, m })), [
    { t: 'k', c: 'KeyA', k: 'a', d: true, m: 0 }, { t: 'k', c: 'KeyA', k: 'a', d: false, m: 0 }]);

  // ⌘C on a Mac keyboard: CDP modifier 4 is Meta → protocol bit 8.
  n = await count(page);
  await page.keyDown('Meta', 'MetaLeft', 4);
  await page.key('c', 'KeyC', { modifiers: 4 });
  await page.keyUp('Meta', 'MetaLeft', 0);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 4`, { what: '⌘C' });
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'k').map(m => `${m.c}${m.d ? '↓' : '↑'}${m.m}`),
    ['MetaLeft↓8', 'KeyC↓8', 'KeyC↑8', 'MetaLeft↑0']);

  // Tab and Escape would move focus or leave full screen in the page; the Mac gets them instead.
  // The viewer takes keys at the window in the capture phase and stops them there, so listen in that same phase.
  const tabPrevented = page.eval(`new Promise(r => addEventListener('keydown', e => r(e.defaultPrevented), { once: true, capture: true }))`);
  await page.key('Tab', 'Tab');
  assert.equal(await tabPrevented, true);

  // A key held when the window loses focus: the viewer tells the Mac to let go of everything.
  n = await count(page);
  await page.keyDown('Shift', 'ShiftLeft', 8);
  await page.eval(`window.dispatchEvent(new Event('blur'))`);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).some(m => m.t === 'rel')`, { what: 'rel' });
  await page.keyUp('Shift', 'ShiftLeft', 0);

  // Our own controls keep their keys: typing in the quality menu sends nothing to the Mac.
  await page.eval(`document.getElementById('tbQuality').focus()`);
  n = await count(page);
  await page.key('ArrowDown', 'ArrowDown');
  await sleep(200);
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'k'), []);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('desktop: toolbar controls — quality, display, stats, keys bar, more menu, full screen, sound, disconnect', async () => {
  const page = await openPage(stack, demoUrl({ sound: 'blocked' }));
  await ready(page);
  assert.equal(await page.eval(`!document.getElementById('soundPrompt').hidden`), true, '"Tap for sound" when sound was blocked');
  await page.shot('viewer-demo-tap-for-sound-desktop');
  let n = await count(page);
  await page.click('#soundPrompt');
  await page.waitFor(`document.getElementById('soundPrompt').hidden && !document.getElementById('video').muted`, { what: 'sound on' });

  await page.eval(`(() => { const s = document.getElementById('tbQuality'); s.value = 'sharp'; s.dispatchEvent(new Event('change')); })()`);
  await page.eval(`(() => { const s = document.getElementById('tbDisplay'); s.value = '2'; s.dispatchEvent(new Event('change')); })()`);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).some(m => m.t === 'display')`);
  const ctl = (await messages(page, n)).filter(m => m.channel === 'control' && m.t !== 'ping');
  assert.deepEqual(ctl.map(m => ({ t: m.t, preset: m.preset, id: m.id })),
    [{ t: 'quality', preset: 'sharp', id: undefined }, { t: 'display', preset: undefined, id: 2 }]);
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem('perch.prefs.v1')).quality`), 'sharp', 'remembered');

  // Connection details: the demo answers pings, so the round trip shows.
  await page.click('#tbStats');
  await page.waitFor(`/Round trip\\s*\\d+ ms/.test(document.getElementById('stats').textContent)`, { what: 'stats with RTT' });
  assert.match(await page.text('#stats'), /Picture/);
  assert.ok((await messages(page)).some(m => m.t === 'ping' && m.channel === 'control'), 'pings every 2 s');

  // Keys bar: sticky ⌘ then Tab is ⌘Tab; Mission Control is Control+Up.
  await page.click('#tbKeys');
  assert.equal(await page.eval(`document.getElementById('keysBar').hidden`), false);
  n = await count(page);
  await page.click('#keysBar [data-mod="8"]');
  assert.equal(await page.eval(`document.querySelector('#keysBar [data-mod="8"]').getAttribute('aria-pressed')`), 'true');
  await page.shot('viewer-demo-keysbar-desktop');
  await page.click('#keysBar [data-key="tab"]');
  await page.click('#keysBar [data-key="missionControl"]');
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 8`);
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'k').map(m => `${m.c}${m.d ? '↓' : '↑'}${m.m}`), [
    'MetaLeft↓8', 'Tab↓8', 'Tab↑8', 'MetaLeft↑0', 'ControlLeft↓2', 'ArrowUp↓2', 'ArrowUp↑2', 'ControlLeft↑0']);
  assert.equal(await page.eval(`document.querySelector('#keysBar [data-mod="8"]').getAttribute('aria-pressed')`), 'false', 'sticky key used up');

  await page.click('#tbMore');
  assert.equal(await page.eval(`document.getElementById('moreMenu').hidden`), false);
  await page.shot('viewer-demo-more-menu-desktop');
  n = await count(page);
  await page.click('#optKeyframe');
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).some(m => m.t === 'keyframe')`);
  assert.equal(await page.eval(`document.getElementById('moreMenu').hidden`), true);

  await page.click('#tbFull');
  await page.waitFor(`!!document.fullscreenElement`, { what: 'full screen' });
  // fullscreenchange (which relabels the button) comes a frame after fullscreenElement is set.
  await page.waitFor(`document.getElementById('tbFull').getAttribute('aria-label') === 'Leave full screen'`, { what: 'button relabelled' });
  await page.click('#tbFull');
  await page.waitFor(`!document.fullscreenElement`, { what: 'left full screen' });

  await page.click('#tbBye');
  await page.waitFor(`!document.getElementById('ended').hidden`, { what: 'ended card' });
  await page.shot('viewer-demo-ended-desktop');
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('status notes: locked, view only, slow link, no screen permission', async () => {
  const page = await openPage(stack, demoUrl({ locked: '1', viewonly: '1' }));
  await ready(page);
  const ids = () => page.eval(`[...document.querySelectorAll('#banners .banner')].map(b => b.dataset.id)`);
  assert.deepEqual(await ids(), ['locked', 'viewonly']);
  assert.match(await page.text('#banners'), /Your Mac is locked/);
  assert.match(await page.text('#banners'), /View only/);
  // View only: clicks send nothing.
  const n = await count(page);
  await page.click(null, { x: 640, y: 420 });
  await sleep(200);
  assert.deepEqual(without(await messages(page, n), 'ping'), []);
  await page.eval(`window.__perch.demoSession.onmessage({ t: 'status', link: 'slow' })`);
  await page.eval(`window.__perch.demoSession.onmessage({ t: 'error', code: 'no-screen-permission', message: 'x' })`);
  assert.deepEqual(await ids(), ['locked', 'viewonly', 'slow', 'error']);
  assert.match(await page.text('#banners'), /Screen & System Audio Recording/);
  await page.shotAll('viewer-banners', { views: { desktop: DESKTOP }, schemes: ['dark'] });
  // "Use Smooth" on the slow note switches quality.
  const m0 = await count(page);
  await page.click('#banners [data-id="slow"] .btn');
  await page.waitFor(`window.__perch.demoMessages.slice(${m0}).some(m => m.t === 'quality' && m.preset === 'smooth')`);
  await page.eval(`window.__perch.demoSession.onmessage({ t: 'status', locked: false, input: true, link: 'good' })`);
  assert.deepEqual(await ids(), ['error']);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('Windows keyboard: "Ctrl acts as ⌘" is on by default and swaps Control and ⌘', async () => {
  const page = await openPage(stack, demoUrl(), { ua: UA.windowsChrome });
  await ready(page);
  assert.equal(await page.eval(`document.getElementById('swapWrap').hidden`), false);
  assert.equal(await page.eval(`document.getElementById('optSwap').checked`), true);
  await page.click(null, { x: 640, y: 400 });
  let n = await count(page);
  await page.keyDown('Control', 'ControlLeft', 2);
  await page.key('c', 'KeyC', { modifiers: 2 });
  await page.keyUp('Control', 'ControlLeft', 0);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 4`);
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'k').map(m => `${m.c}${m.d ? '↓' : '↑'}${m.m}`),
    ['MetaLeft↓8', 'KeyC↓8', 'KeyC↑8', 'MetaLeft↑0'], 'Ctrl+C arrives as ⌘C');
  // Turn it off in the More menu: Control is Control again.
  await page.click('#tbMore');
  await page.click('#optSwap');
  await page.click(null, { x: 640, y: 400 });
  n = await count(page);
  await page.keyDown('Control', 'ControlLeft', 2);
  await page.keyUp('Control', 'ControlLeft', 0);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 2`);
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'k').map(m => `${m.c}${m.d ? '↓' : '↑'}${m.m}`),
    ['ControlLeft↓2', 'ControlLeft↑0']);
  await page.close();
});

test('phone: taps, double taps, long press, two-finger scroll, pinch zoom, the phone keyboard', async () => {
  const page = await openPage(stack, demoUrl(), { view: PHONE, ua: UA.iphone });
  await ready(page);
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('touch')`), true);
  assert.equal(await page.eval(`document.getElementById('tbKeyboard').hidden`), false, 'keyboard button on a phone');
  await page.shot('viewer-demo-toolbar-phone');

  // Tap in the middle of the picture → a left click there.
  let n = await count(page);
  await page.tap(195, 422);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`, { what: 'tap' });
  let want = await expected(page, 195, 422);
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'b').map(({ b, d, n: c, x, y }) => ({ b, d, n: c, x, y })), [
    { b: 0, d: true, n: 1, x: want.x, y: want.y }, { b: 0, d: false, n: 1, x: want.x, y: want.y }]);

  // Double tap → the second click has count 2.
  await sleep(500);
  n = await count(page);
  await page.tap(150, 400);
  await sleep(60);
  await page.tap(153, 402);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 4`, { what: 'double tap' });
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'b').map(m => `${m.d ? '↓' : '↑'}${m.n}`), ['↓1', '↑1', '↓2', '↑2']);

  // Long press → right click while the finger is still down.
  await sleep(500);
  n = await count(page);
  await page.touch('touchStart', [{ x: 250, y: 380 }]);
  await sleep(800);
  await page.touch('touchEnd', []);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`, { what: 'long press' });
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'b').map(m => [m.b, m.d]), [[2, true], [2, false]]);

  // Two fingers moving up → scroll the Mac (positive dy).
  n = await count(page);
  await page.touch('touchStart', [{ x: 150, y: 450, id: 0 }, { x: 240, y: 450, id: 1 }]);
  for (let i = 1; i <= 6; i++) {
    await page.touch('touchMove', [{ x: 150, y: 450 - 12 * i, id: 0 }, { x: 240, y: 450 - 12 * i, id: 1 }]);
    await sleep(20);
  }
  await page.touch('touchEnd', []);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).some(m => m.t === 'w')`, { what: 'two-finger scroll' });
  const scrolled = (await messages(page, n)).filter(m => m.t === 'w').reduce((s, m) => s + m.dy, 0);
  assert.ok(scrolled > 40, `scrolled ${scrolled}`);
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'b'), [], 'no clicks from scrolling');

  // Pinch out → local zoom only (nothing sent), and taps then map through the zoom.
  await sleep(400);
  n = await count(page);
  await page.touch('touchStart', [{ x: 160, y: 420, id: 0 }, { x: 230, y: 420, id: 1 }]);
  for (let i = 1; i <= 6; i++) {
    await page.touch('touchMove', [{ x: 160 - 10 * i, y: 420, id: 0 }, { x: 230 + 10 * i, y: 420, id: 1 }]);
    await sleep(20);
  }
  await page.touch('touchEnd', []);
  await page.waitFor(`document.getElementById('viewer').classList.contains('zoomed')`, { what: 'zoomed in' });
  const view = (await geometry(page)).view;
  assert.ok(view.scale > 1.5, `zoom ${view.scale}`);
  assert.match(await page.eval(`document.getElementById('zoom').style.transform`), /scale\(/);
  assert.deepEqual(without(await messages(page, n), 'ping', 'm'), [], 'zooming sends nothing to the Mac');
  await page.shot('viewer-demo-zoomed-phone');
  await sleep(500);
  n = await count(page);
  await page.tap(100, 300);
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`);
  want = await expected(page, 100, 300);
  const zoomedTap = (await messages(page, n)).find(m => m.t === 'b');
  assert.deepEqual([zoomedTap.x, zoomedTap.y], [want.x, want.y]);
  const unzoomed = toDisplay(100, 300, (await geometry(page)).box, 756, 491);
  assert.notDeepEqual([zoomedTap.x, zoomedTap.y], [unzoomed.x, unzoomed.y], 'the zoom changed where the tap lands');
  // Two-finger double tap → whole screen again.
  for (let i = 0; i < 2; i++) {
    await page.touch('touchStart', [{ x: 150, y: 400, id: 0 }, { x: 230, y: 400, id: 1 }]);
    await sleep(40);
    await page.touch('touchEnd', []);
    await sleep(80);
  }
  await page.waitFor(`!document.getElementById('viewer').classList.contains('zoomed')`, { what: 'zoom reset' });

  // The keyboard button focuses the hidden text box; what the phone keyboard types arrives as text. The toolbar has
  // tucked itself away during the gestures above, so bring it back with its handle first, as a person would.
  if (!(await page.eval(`document.getElementById('viewer').classList.contains('tb-on')`))) {
    await page.tap(...Object.values(await page.center('#handle')).slice(0, 2));
    await page.waitFor(`document.getElementById('viewer').classList.contains('tb-on')`, { what: 'toolbar back' });
    await sleep(300); // its slide-in
  }
  await page.tap(...Object.values(await page.center('#tbKeyboard')).slice(0, 2));
  await page.waitFor(`document.activeElement === document.getElementById('softkbd')`, { what: 'soft keyboard focus' });
  n = await count(page);
  await page.type('héllo 👋');
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).some(m => m.t === 'txt')`, { what: 'typed text' });
  assert.equal((await messages(page, n)).filter(m => m.t === 'txt').map(m => m.s).join(''), 'héllo 👋');
  n = await count(page);
  await page.key('Backspace', 'Backspace');
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).some(m => m.t === 'k' && m.c === 'Backspace')`, { what: 'backspace' });
  // The keyboard button that is always on screen: its text box takes the tap itself (what iPhones need to open the
  // keyboard), the special keys come up with the keyboard, and a second tap closes both.
  await page.eval(`document.getElementById('softkbd').blur()`);
  await page.waitFor(`!document.getElementById('kbdFab').hidden && !document.getElementById('kbdFab').classList.contains('open')`,
    { what: 'keyboard button, closed' });
  assert.equal(await page.eval(`document.getElementById('keysBar').hidden`), true, 'special keys went away with the keyboard');
  await page.tap(...Object.values(await page.center('#kbdFab')).slice(0, 2));
  await page.waitFor(`document.activeElement === document.getElementById('softkbd')`, { what: 'keyboard opened from the button' });
  assert.equal(await page.eval(`document.getElementById('kbdFab').classList.contains('open')`), true);
  assert.equal(await page.eval(`document.getElementById('keysBar').hidden`), false, 'special keys come up with the keyboard');
  n = await count(page);
  await page.type('ok');
  await page.waitFor(`window.__perch.demoMessages.slice(${n}).some(m => m.t === 'txt')`, { what: 'typed text from the button' });
  await page.shot('viewer-demo-keysbar-phone');
  await page.setView({ view: PHONE_LANDSCAPE });
  await page.shot('viewer-demo-keysbar-phone-landscape');
  await page.setView({ view: PHONE });
  await page.tap(...Object.values(await page.center('#kbdFab')).slice(0, 2));
  await page.waitFor(`document.activeElement !== document.getElementById('softkbd')`, { what: 'keyboard closed by a second tap' });
  assert.equal(await page.eval(`document.getElementById('keysBar').hidden`), true, 'special keys go away with it');
  assert.deepEqual(page.problems(), []);
  await page.close();
});

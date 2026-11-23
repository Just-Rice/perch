// Demo mode (connect.html?demo=1 on localhost): the viewer with a canvas test picture and no network. Real mouse,
// touch and keyboard events (CDP Input.*) must turn into exactly the protocol's input messages, and the Dock, the
// Command palette, Tweaks and the Key deck must reach every feature.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openPage, DESKTOP, PHONE, PHONE_LANDSCAPE, UA, sleep } from './lib/browser.mjs';
import { toDisplay, followPan } from '../../site/js/viewer/coords.js';

let stack;
test.before(async () => { stack = await startStack({ broker: false }); });
test.after(async () => { await stack?.close(); });
test.afterEach(async () => { await stack?.closePages(); });

const demoUrl = (params = {}) => `${stack.base}connect.html?${new URLSearchParams({ demo: '1', ...params })}`;

// Messages the viewer sent since `from` (an index into the demo's list).
const messages = (page, from = 0) => page.eval(`window.__roost.demoMessages.slice(${from})`);
const count = page => page.eval('window.__roost.demoMessages.length');
const without = (list, ...types) => list.filter(m => !types.includes(m.t));
const keysOf = list => list.filter(m => m.t === 'k').map(m => `${m.c}${m.d ? '↓' : '↑'}${m.m}`);

async function geometry(page) {
  return page.eval(`(() => { const b = document.getElementById('surface').getBoundingClientRect(); const v = document.getElementById('video');
    return { box: { left: b.left, top: b.top, width: b.width, height: b.height }, vw: v.videoWidth, vh: v.videoHeight,
      view: window.__roost.viewer.view }; })()`);
}

// Where the page should say (x, y) is on the PC, from its own geometry: an independent check of the mapping.
async function expected(page, x, y) {
  const g = await geometry(page);
  return toDisplay(x, y, g.box, g.vw, g.vh, g.view);
}

// The tests of where things land on the PC measure against the whole window: let the Dock float over the picture.
async function floatingDock(page) {
  await page.eval(`(() => { const v = window.__roost.viewer; v.prefs.values.dockRoom = false; v._placeDock(); })()`);
}

const rect = (page, sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const hidden = (page, id) => page.eval(`document.getElementById('${id}').hidden`);
const tweaks = async page => { await page.eval(`window.__roost.viewer._toggleTweaks(true)`); await sleep(300); }; // after its slide-in

async function ready(page) {
  await page.waitFor(`(() => { const v = document.getElementById('video'); return !document.getElementById('viewer').hidden && v.videoWidth > 0 && v.readyState >= 2; })()`,
    { what: 'the demo picture' });
  const t0 = await page.eval(`document.getElementById('video').currentTime`);
  await sleep(400);
  assert.ok(await page.eval(`document.getElementById('video').currentTime`) > t0, 'the picture is moving');
}

test('desktop: the viewer shows the test picture, with the Dock at the top and the picture clear of it', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  assert.equal(await hidden(page, 'app'), true, 'sign-in screens are gone');
  assert.equal(await page.eval(`getComputedStyle(document.getElementById('video')).objectFit`), 'contain');
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('at-top')`), true);
  assert.equal(await page.text('#dockName'), 'demo-pc-0000');
  assert.equal(await hidden(page, 'dkDisplay'), false, 'two displays: a display button');
  assert.equal(await page.text('#dkDisplayNum'), '1');
  assert.equal(await hidden(page, 'dkKeyboard'), true, 'no keyboard button on a desktop');
  assert.equal(await hidden(page, 'kbdFab'), true, 'no floating keyboard button on a desktop');
  assert.equal(await page.eval(`document.getElementById('optSwap').checked`), true, 'this Chrome says Mac: "⌘ is Ctrl" is on');
  await page.shot('viewer-demo-dock-desktop');
  await page.shotAll('viewer-dock', { views: { desktop: DESKTOP } });
  // By default the Dock stays put at the top, and the picture sits below it rather than under it.
  const dock = await rect(page, '#dock');
  const surfTop = await page.eval(`document.getElementById('surface').getBoundingClientRect().top`);
  assert.ok(surfTop >= dock.bottom && surfTop - dock.bottom < 20, `picture starts below the Dock (${dock.bottom} vs ${surfTop})`);
  // Chosen to tuck itself away, it slides off, and comes back when the mouse touches the very top.
  await tweaks(page);
  await page.eval(`(() => { const s = document.getElementById('optDockIdle'); s.value = 'hide'; s.dispatchEvent(new Event('change')); })()`);
  await page.eval(`window.__roost.viewer._toggleTweaks(false)`);
  assert.equal(await page.eval(`document.getElementById('surface').getBoundingClientRect().top`), 0, 'the picture fills the window again');
  assert.match(await page.text('#banners'), /tucks itself away/);
  await page.eval(`document.getElementById('surface').focus()`); // as after a click on the picture
  await page.mouse('mouseMoved', 640, 500);
  await page.waitFor(`document.getElementById('viewer').classList.contains('dock-away')`, { timeoutMs: 8000, what: 'Dock tucked away' });
  assert.equal(await hidden(page, 'dockLip'), true, 'no lip in the way of clicks with a mouse');
  await page.shot('viewer-demo-clean-desktop');
  await page.mouse('mouseMoved', 640, 10);
  await sleep(150);
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('dock-away')`), true, 'near the top is not enough');
  await page.mouse('mouseMoved', 640, 1);
  await page.waitFor(`!document.getElementById('viewer').classList.contains('dock-away')`, { what: 'Dock back' });
  await page.eval(`localStorage.removeItem('roost.prefs.v1')`); // the next tests start from the usual
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('the Command palette: Ctrl+Alt+Shift+K, search, arrow keys and Enter run any action', async () => {
  const page = await openPage(stack, demoUrl({ log: '0' }));
  await ready(page);
  await page.click(null, { x: 640, y: 400 });
  let n = await count(page);
  await page.keyDown('Control', 'ControlLeft', 2);
  await page.keyDown('Alt', 'AltLeft', 3);
  await page.keyDown('Shift', 'ShiftLeft', 11);
  await page.key('K', 'KeyK', { modifiers: 11 });
  await page.keyUp('Shift', 'ShiftLeft', 3);
  await page.keyUp('Alt', 'AltLeft', 2);
  await page.keyUp('Control', 'ControlLeft', 0);
  await page.waitFor(`!document.getElementById('palette').hidden`, { what: 'the palette' });
  assert.equal(await page.eval(`document.activeElement.id`), 'paletteInput');
  assert.ok(!keysOf(await messages(page, n)).some(k => k.startsWith('KeyK')), 'the shortcut itself never reaches the PC');
  // Everything is there: quality, displays, keys, clipboard, the Dock, the session.
  const all = await page.eval(`[...document.querySelectorAll('#paletteList .pi')].map(li => li.dataset.id)`);
  for (const id of ['quality-fast', 'shape-fill', 'display-2', 'deck', 'swap', 'press-taskManager', 'press-altTab', 'paste', 'copy',
    'clip-sync', 'capture', 'dock-bottom-right', 'dock-orb', 'stats', 'disconnect', 'window-whole']) assert.ok(all.includes(id), id);
  assert.ok(!all.includes('press-lock'), 'no Win+L: Windows keeps it for itself');
  await page.shotAll('viewer-palette', { views: { desktop: DESKTOP }, schemes: ['light', 'dark'] });
  // Search: "task man" finds Task Manager first; Enter presses Ctrl+Shift+Esc on the PC.
  await page.type('task man');
  await sleep(100);
  assert.equal(await page.eval(`document.querySelector('#paletteList .pi[aria-selected=true]').dataset.id`), 'press-taskManager');
  await page.shot('viewer-palette-search');
  n = await count(page);
  await page.key('Enter', 'Enter');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 6`, { what: 'Ctrl+Shift+Esc' });
  assert.deepEqual(keysOf(await messages(page, n)),
    ['ControlLeft↓2', 'ShiftLeft↓3', 'Escape↓3', 'Escape↑3', 'ShiftLeft↑2', 'ControlLeft↑0']);
  assert.equal(await hidden(page, 'palette'), true, 'closed after running');
  // Arrow keys move along the list, Escape closes it; a toggle shows its state.
  await page.click('#dkPalette');
  await page.type('connection details');
  await sleep(100);
  assert.equal(await page.eval(`document.querySelector('#paletteList .pi[aria-selected=true] .pi-state').textContent`), 'Off');
  await page.key('Enter', 'Enter');
  await page.waitFor(`!document.getElementById('stats').hidden`, { what: 'connection details' });
  await page.click('#dkPalette');
  await page.key('ArrowDown', 'ArrowDown');
  await page.key('ArrowDown', 'ArrowDown');
  assert.equal(await page.eval(`document.querySelector('#paletteList .pi[aria-selected=true]').dataset.i`), '2');
  await page.key('Escape', 'Escape');
  assert.equal(await hidden(page, 'palette'), true);
  // Nothing matches: says so.
  await page.click('#dkPalette');
  await page.type('zzzqqq');
  await sleep(100);
  assert.equal(await hidden(page, 'paletteEmpty'), false);
  await page.key('Escape', 'Escape');
  await page.eval(`localStorage.removeItem('roost.prefs.v1')`);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('desktop: capturing the mouse, as games do: the PC’s pointer moves by how far the mouse goes', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  await floatingDock(page);
  assert.equal(await hidden(page, 'dkCapture'), false);
  // Start from a known place: the middle of the PC's screen.
  const mid = await page.eval(`(() => { const r = document.getElementById('surface').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mid.x, y: mid.y });
  await page.click('#dkCapture');
  const real = await page.waitFor(`document.pointerLockElement === document.getElementById('surface')`, { what: 'pointer lock', timeoutMs: 3000 })
    .then(() => true, () => false);
  if (!real) {
    // Headless Chrome may refuse pointer lock: play the browser's part (as it would report a lock).
    await page.eval(`(() => { const s = document.getElementById('surface');
      Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => s });
      document.dispatchEvent(new Event('pointerlockchange')); })()`);
  }
  // The browser announces the lock a moment after granting it.
  await page.waitFor(`document.getElementById('viewer').classList.contains('captured')`, { what: 'the page noticing the capture' });
  assert.equal(await page.eval(`document.getElementById('dkCapture').getAttribute('aria-pressed')`), 'true');
  assert.ok(await page.eval(`!!document.querySelector('#banners [data-id="capture"]')`), 'the "Press Esc to let go" note');
  const n = await count(page);
  // Movement only: the page's pointer stays put while the PC's moves. A tenth of the picture to the right, then a
  // long way up past the top edge, where the position stops but the movement still counts.
  const shown = await page.eval(`window.__roost.viewer.pointer.shownSize()`);
  const move = (dx, dy) => page.eval(`document.getElementById('surface').dispatchEvent(new PointerEvent('pointermove',
    { pointerType: 'mouse', bubbles: true, clientX: ${mid.x}, clientY: ${mid.y}, movementX: ${dx}, movementY: ${dy} }))`);
  await move(shown[0] / 10, 0);
  await sleep(80);
  await move(0, -shown[1]);
  await sleep(80);
  await page.eval(`document.getElementById('surface').dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true, button: 0, buttons: 1, clientX: 5, clientY: 5 }))`);
  await page.eval(`document.getElementById('surface').dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', bubbles: true, button: 0, clientX: 5, clientY: 5 }))`);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`, { what: 'the click' });
  const sent = (await messages(page, n)).filter(m => m.t === 'm' || m.t === 'b');
  const r = v => Math.round(v * 1000) / 1000;
  const moves = sent.filter(m => m.t === 'm');
  assert.deepEqual(moves.map(m => [r(m.x), r(m.y), r(m.dx), r(m.dy)]), [[0.6, 0.5, 0.1, 0], [0.6, 0, 0, -1]]);
  const clicks = sent.filter(m => m.t === 'b');
  assert.deepEqual(clicks.map(m => [r(m.x), r(m.y)]), [[0.6, 0], [0.6, 0]], 'clicks land where the PC’s pointer is, not under the hidden one');
  // Too fast (or slow)? Tweaks has the captured mouse's speed: at half, the same movement goes half as far.
  assert.equal(await hidden(page, 'mouseSpeedWrap'), false);
  await page.eval(`(() => { const s = document.getElementById('optMouseSpeed'); s.value = '0.5'; s.dispatchEvent(new Event('input')); })()`);
  assert.equal(await page.text('#mouseSpeedValue'), '0.5×');
  await page.eval(`window.__roost.viewer._tweaksAt('twMouse')`);
  await sleep(400);
  await page.shot('viewer-mouse-speed-tweaks');
  await page.eval(`window.__roost.viewer._toggleTweaks(false)`);
  const n2 = await count(page);
  await move(shown[0] / 10, shown[1] / 10);
  await page.waitFor(`window.__roost.demoMessages.slice(${n2}).some(m => m.t === 'm')`, { what: 'a slower move' });
  const slow = (await messages(page, n2)).find(m => m.t === 'm');
  assert.deepEqual([r(slow.x), r(slow.y), r(slow.dx), r(slow.dy)], [0.65, 0.05, 0.05, 0.05]);
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem('roost.prefs.v1')).mouseSpeed`), 0.5, 'remembered');
  if (real) {
    await page.eval(`document.exitPointerLock()`);
  } else {
    await page.eval(`delete document.pointerLockElement; document.dispatchEvent(new Event('pointerlockchange'))`);
  }
  await page.waitFor(`!document.getElementById('viewer').classList.contains('captured')`, { what: 'let go' });
  await page.eval(`localStorage.removeItem('roost.prefs.v1')`);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('clipboard: paste this device’s text on the PC, copy the PC’s text here, and the fallback box', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  // A stand-in for this device's clipboard, so no real clipboard is read or written: it can say yes or no.
  await page.eval(`(() => {
    const c = window.__clip = { text: 'hello from this computer', refuse: false, written: [] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: async () => { if (c.refuse) throw new DOMException('no', 'NotAllowedError'); return c.text; },
      writeText: async t => { if (c.refuse) throw new DOMException('no', 'NotAllowedError'); c.written.push(t); },
      write: async items => { if (c.refuse) throw new DOMException('no', 'NotAllowedError');
        for (const i of items) c.written.push(await (await i.getType('text/plain')).text()); },
    } });
  })()`);
  const fromTweaks = async id => { await tweaks(page); await page.click(id); };
  let n = await count(page);
  await fromTweaks('#optPaste');
  await page.waitFor(`window.__roost.demoSession.clipboard === 'hello from this computer'`, { what: 'the text on the PC' });
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'clip-set').map(m => [m.text, m.paste]), [['hello from this computer', true]]);
  await page.waitFor(`/Pasted on your PC/.test(document.getElementById('banners').textContent)`, { what: '"Pasted on your PC."' });
  assert.equal(await hidden(page, 'tweaks'), true, 'Tweaks closed for the paste');

  // The browser won't read its clipboard: the box to paste into comes up, with "only the clipboard" too.
  await page.eval(`window.__clip.refuse = true`);
  await fromTweaks('#optPaste');
  await page.waitFor(`!document.getElementById('clipSheet').hidden`, { what: 'the paste box' });
  assert.equal(await page.eval(`document.activeElement.id`), 'clipText');
  await page.shotAll('viewer-paste-box', { views: { desktop: DESKTOP, phone: PHONE } });
  await page.eval(`document.getElementById('clipText').value = 'just keep this'`);
  await page.click('#clipOnly');
  await page.waitFor(`window.__roost.demoSession.clipboard === 'just keep this' && document.getElementById('clipSheet').hidden`, { what: 'clipboard only' });
  assert.equal((await messages(page)).filter(m => m.t === 'clip-set').at(-1).paste, false);

  // Copy from the PC, from the Command palette this time.
  await page.eval(`window.__clip.refuse = false; window.__roost.demoSession.clipboard = 'copied on the PC — café'`);
  await page.click('#dkPalette');
  await page.type('copy the pc');
  await page.key('Enter', 'Enter');
  await page.waitFor(`window.__clip.written.length === 1`, { what: 'the PC’s text on this device' });
  assert.deepEqual(await page.eval(`window.__clip.written`), ['copied on the PC — café']);
  await page.waitFor(`/Copied from your PC/.test(document.getElementById('banners').textContent)`, { what: '"Copied from your PC."' });
  // ...and where the browser won't write it, the text is shown, selected, to copy by hand.
  await page.eval(`window.__clip.refuse = true`);
  await fromTweaks('#optCopy');
  await page.waitFor(`!document.getElementById('clipSheet').hidden`, { what: 'the text shown to copy' });
  assert.equal(await page.eval(`document.getElementById('clipText').value`), 'copied on the PC — café');
  assert.deepEqual(await page.eval(`[document.getElementById('clipText').readOnly, document.getElementById('clipGo').hidden]`), [true, true]);
  await page.click('#clipClose');
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('clipboard: Ctrl+V (⌘V on a Mac) pastes this device’s picture or text on the PC, and what’s copied there comes here', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  await page.click(null, { x: 640, y: 400 });
  assert.equal(await hidden(page, 'clipSyncWrap'), false);
  await page.waitFor(`window.__roost.demoSession.clipSync === true`, { what: 'the viewer asks for the PC’s copies' });
  await page.eval(`(() => {
    const c = window.__clip = { written: [] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async items => { for (const i of items) c.written.push(i.types.slice().sort()); },
      writeText: async t => c.written.push(['text:' + t]),
    } });
    // ⌘V as the browser on a Mac sees it, then (optionally) the browser's paste event with this device's clipboard.
    window.__pasteKey = (fill) => {
      const kd = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', metaKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(kd);
      if (fill) {
        const dt = new DataTransfer();
        fill(dt);
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
      document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', code: 'KeyV', metaKey: true, bubbles: true, cancelable: true }));
      return kd.defaultPrevented;
    };
  })()`);
  const PASTE = ['ControlLeft↓2', 'KeyV↓2', 'KeyV↑2', 'ControlLeft↑0'];

  // A picture (bigger than one piece) on this device's clipboard.
  let n = await count(page);
  const prevented = await page.eval(`window.__pasteKey(dt => {
    const bytes = new Uint8Array(100 * 1024).map((_, i) => i % 251);
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
  })`);
  assert.equal(prevented, false, 'the browser’s paste is let through');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 4`, { what: 'Ctrl+V on the PC' });
  const sent = await messages(page, n);
  const parts = sent.filter(m => m.t === 'clip-part');
  assert.equal(parts.length, 3);
  assert.deepEqual(sent.filter(m => m.t === 'clip-set').map(m => [m.paste, m.text, m.img?.mime]), [[false, undefined, 'image/png']]);
  assert.equal(await page.eval(`atob(window.__roost.demoSession.clipboardImage).length`), 100 * 1024);
  assert.deepEqual(keysOf(await messages(page, n)), PASTE, 'pasted after the picture arrived, V never sent early; ⌘ is Ctrl');
  await page.waitFor(`/Pasted on your PC/.test(document.getElementById('banners').textContent)`, { what: '"Pasted on your PC."' });

  // Text.
  n = await count(page);
  await page.eval(`window.__pasteKey(dt => dt.setData('text/plain', 'from the Chromebook'))`);
  await page.waitFor(`window.__roost.demoSession.clipboard === 'from the Chromebook'`, { what: 'the text on the PC' });
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 4`, { what: 'Ctrl+V' });

  // Nothing here, or no paste event at all: the PC pastes its own clipboard.
  for (const fill of ['dt => {}', 'null']) {
    n = await count(page);
    await page.eval(`window.__pasteKey(${fill})`);
    await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 4`, { what: 'Ctrl+V' });
    assert.deepEqual((await messages(page, n)).filter(m => m.t.startsWith('clip')), []);
    assert.deepEqual(keysOf(await messages(page, n)), PASTE);
  }

  // Copied on the PC (a picture and its text): onto this device's clipboard by itself.
  await page.eval(`(() => {
    const s = window.__roost.demoSession;
    s.onmessage({ t: 'clip-part', id: 'm1', i: 0, n: 1, data: btoa('not really a png') });
    s.onmessage({ t: 'clip', ok: true, text: 'caption', img: { id: 'm1', mime: 'image/png' }, auto: true });
  })()`);
  await page.waitFor(`window.__clip.written.length === 1`, { what: 'the PC’s copy here' });
  assert.deepEqual(await page.eval(`window.__clip.written[0]`), ['image/png', 'text/plain']);
  await page.waitFor(`/Picture copied from your PC/.test(document.getElementById('banners').textContent)`, { what: 'the note' });

  // Turned off: the PC is told.
  await tweaks(page);
  await page.click('#optClipSync');
  await page.waitFor(`window.__roost.demoSession.clipSync === false`, { what: 'sharing off' });
  await page.eval(`localStorage.clear()`);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('desktop: mouse moves, clicks, double clicks, right clicks and scrolling', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  await floatingDock(page);
  let n = await count(page);
  await page.mouse('mouseMoved', 640, 400);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'm')`, { what: 'a pointer move' });
  const move = (await messages(page, n)).find(m => m.t === 'm');
  const want = await expected(page, 640, 400);
  assert.equal(move.channel, 'pointer');
  assert.deepEqual([move.x, move.y], [want.x, want.y]);
  assert.ok(Math.abs(move.x - 0.5) < 0.001 && Math.abs(move.y - 0.5) < 0.001, 'the middle of the window is the middle of the PC');

  // A click near the left edge of the picture (inside the letterbox bars' neighbour).
  const g = await geometry(page);
  const pic = { x: g.box.left + (g.box.width - g.vw * Math.min(g.box.width / g.vw, g.box.height / g.vh)) / 2 };
  const cx = pic.x + 30, cy = 300;
  n = await count(page);
  await page.click(null, { x: cx, y: cy });
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`, { what: 'button down and up' });
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
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 4`, { what: 'double click' });
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'b').map(m => `${m.d ? '↓' : '↑'}${m.n}`), ['↓1', '↑1', '↓2', '↑2']);

  // Right click: button 2, and the browser's own menu doesn't open.
  n = await count(page);
  await page.eval(`(() => { window.__menuPrevented = new Promise(r => document.getElementById('surface').addEventListener('contextmenu', e => r(e.defaultPrevented), { once: true })); })()`);
  await page.click(null, { x: 500, y: 300, button: 'right' });
  assert.equal(await page.eval(`window.__menuPrevented`), true);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`);
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'b').map(m => [m.b, m.d]), [[2, true], [2, false]]);

  // Scrolling: pixel deltas, one message per frame.
  n = await count(page);
  await page.mouse('mouseWheel', 640, 400, { deltaX: 0, deltaY: 120 });
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'w')`, { what: 'a scroll' });
  const wheel = (await messages(page, n)).find(m => m.t === 'w');
  assert.equal(wheel.channel, 'input');
  assert.equal(wheel.dy, 120);
  assert.equal(wheel.dx, 0);
  assert.ok(Math.abs(wheel.x - 0.5) < 0.001);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('desktop: keys go to the PC with the protocol\'s code, key and modifier bits; ⌘ is Ctrl on a Mac; focus loss releases them', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  await page.click(null, { x: 640, y: 400 });
  let n = await count(page);
  await page.key('a', 'KeyA', { text: 'a' });
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 2`, { what: 'key a' });
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'k').map(({ t, c, k, d, m }) => ({ t, c, k, d, m })), [
    { t: 'k', c: 'KeyA', k: 'a', d: true, m: 0 }, { t: 'k', c: 'KeyA', k: 'a', d: false, m: 0 }]);

  // ⌘C on a Mac keyboard: "⌘ is Ctrl" is on for Apple devices, so the PC gets Ctrl+C (bit 2).
  n = await count(page);
  await page.keyDown('Meta', 'MetaLeft', 4);
  await page.key('c', 'KeyC', { modifiers: 4 });
  await page.keyUp('Meta', 'MetaLeft', 0);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 4`, { what: '⌘C' });
  assert.deepEqual(keysOf(await messages(page, n)), ['ControlLeft↓2', 'KeyC↓2', 'KeyC↑2', 'ControlLeft↑0']);

  // Tab and Escape would move focus or leave full screen in the page; the PC gets them instead.
  // The viewer takes keys at the window in the capture phase and stops them there, so listen in that same phase.
  await page.eval(`(() => { window.__tabPrevented = new Promise(r => addEventListener('keydown', e => r(e.defaultPrevented), { once: true, capture: true })); })()`);
  await page.key('Tab', 'Tab');
  assert.equal(await page.eval(`window.__tabPrevented`), true);

  // A key held when the window loses focus: the viewer tells the PC to let go of everything.
  n = await count(page);
  await page.keyDown('Shift', 'ShiftLeft', 8);
  await page.eval(`window.dispatchEvent(new Event('blur'))`);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'rel')`, { what: 'rel' });
  await page.keyUp('Shift', 'ShiftLeft', 0);

  // Our own controls keep their keys: moving along the quality choices in Tweaks sends nothing to the PC.
  await tweaks(page);
  await page.eval(`document.querySelector('#qualityGroup input:checked').focus()`);
  n = await count(page);
  await page.key('ArrowRight', 'ArrowRight');
  await sleep(200);
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'k'), []);
  await page.eval(`localStorage.clear()`);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('desktop: sound levels — what is sent here and the PC\'s speakers, set on the PC from Tweaks', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  const n = await count(page);
  await page.click('#dkTweaks');
  assert.equal(await hidden(page, 'tweaks'), false);
  assert.equal(await page.eval(`document.getElementById('dkTweaks').getAttribute('aria-expanded')`), 'true');
  assert.equal(await hidden(page, 'levelsWrap'), false, 'shown to the owner of a PC that has them');
  assert.equal(await page.text('#optStreamOut'), '100%');
  assert.equal(await page.text('#optSpeakersOut'), '100%');
  const slide = (id, v) => page.eval(`(() => { const s = document.getElementById('${id}'); s.value = '${v}';
    s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await slide('optSpeakers', 0);
  assert.equal(await page.text('#optSpeakersOut'), 'Silent');
  await slide('optStream', 130);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'levels').length >= 2`, { what: 'levels sent' });
  const last = (await messages(page, n)).filter(m => m.t === 'levels').at(-1);
  assert.equal(last.channel, 'control');
  assert.equal(last.speakers, 0);
  assert.ok(Math.abs(last.stream - 1.3) < 1e-9, String(last.stream));
  // The PC's echo doesn't pull the sliders back.
  await sleep(700);
  assert.equal(await page.eval(`document.getElementById('optStream').value`), '130');
  await page.shotAll('viewer-tweaks', { views: { desktop: DESKTOP } });
  // Closed with Escape, or by clicking the picture.
  await page.key('Escape', 'Escape');
  assert.equal(await hidden(page, 'tweaks'), true);
  await page.eval(`localStorage.clear()`);
  await page.close();
});

test('desktop: displays — the map, and holding the pointer at an edge moves to the display beyond it', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  const n = await count(page);
  const shown = () => page.eval(`document.querySelector('#dkDisplays .display-chip[aria-pressed=true]').textContent`);

  // The map: both displays, side by side (the demo PC, like one before 0.3.3, doesn't say where they sit).
  await page.click('#dkDisplay');
  assert.equal(await hidden(page, 'displayMap'), false);
  assert.equal(await page.eval(`document.querySelectorAll('#dkDisplays .display-chip').length`), 2, 'a button for each display');
  assert.equal(await page.eval(`document.querySelectorAll('#displayMapArea .map-display').length`), 2);
  const [a, b] = await page.eval(`[...document.querySelectorAll('#displayMapArea .map-display')].map(e => e.getBoundingClientRect().left)`);
  assert.ok(a < b, 'the first display on the left');
  const map = await rect(page, '#displayMap'), dock = await rect(page, '#dock');
  assert.ok(map.top > dock.bottom, 'opens under the Dock at the top');
  await page.shotAll('viewer-display-map', { views: { desktop: DESKTOP } });
  await page.click('#displayMapArea .map-display:nth-child(2)');
  assert.equal(await shown(), '2');
  assert.equal(await page.text('#dkDisplayNum'), '2');
  await page.mouse('mousePressed', 640, 400, { button: 'left', clickCount: 1 });
  await page.mouse('mouseReleased', 640, 400, { button: 'left', clickCount: 1 });
  assert.equal(await hidden(page, 'displayMap'), true, 'a click on the picture closes it');

  // The edge flip: display 2 has display 1 to its left. Resting at the left edge names it, then moves there.
  const box = await page.eval(`(() => { const r = document.getElementById('surface').getBoundingClientRect(); return { l: r.left, r: r.right, y: (r.top + r.bottom) / 2 }; })()`);
  await page.mouse('mouseMoved', box.l + 200, box.y);
  await page.mouse('mouseMoved', box.l + 1, box.y);
  await page.waitFor(`!document.getElementById('edgeHint').hidden`, { what: 'edge hint' });
  assert.match(await page.text('#edgeHintText'), /^← Laptop/);
  await page.shot('viewer-demo-edge-flip-desktop');
  await page.waitFor(`document.querySelector('#dkDisplays .display-chip[aria-pressed=true]').textContent === '1'`, { what: 'flipped to display 1' });
  assert.equal(await hidden(page, 'edgeHint'), true);
  // Still at the edge: it doesn't flip again until the pointer has moved away.
  await sleep(700);
  assert.equal(await shown(), '1');
  await page.mouse('mouseMoved', box.r - 200, box.y);
  await page.mouse('mouseMoved', box.r - 1, box.y);
  await page.waitFor(`document.querySelector('#dkDisplays .display-chip[aria-pressed=true]').textContent === '2'`, { what: 'and on to display 2' });
  // And from the Command palette.
  await page.click('#dkPalette');
  await page.type('display 1');
  await page.key('Enter', 'Enter');
  assert.equal(await shown(), '1');
  const ids = (await messages(page, n)).filter(m => m.t === 'display').map(m => m.id);
  assert.deepEqual(ids, [2, 1, 2, 1]);
  await page.eval(`localStorage.clear()`);
});

test('desktop: the Dock’s controls — quality, Key deck, Tweaks, full screen, sound, disconnect', async () => {
  const page = await openPage(stack, demoUrl({ sound: 'blocked' }));
  await ready(page);
  assert.equal(await page.eval(`!document.getElementById('soundPrompt').hidden`), true, '"Tap for sound" when sound was blocked');
  await page.shot('viewer-demo-tap-for-sound-desktop');
  let n = await count(page);
  await page.click('#soundPrompt');
  await page.waitFor(`document.getElementById('soundPrompt').hidden && !document.getElementById('video').muted`, { what: 'sound on' });
  assert.equal(await page.eval(`document.getElementById('dkSound').getAttribute('aria-label')`), 'Mute');
  await page.click('#dkSound');
  assert.equal(await page.eval(`document.getElementById('video').muted`), true, 'muted from the Dock');
  await page.click('#dkSound');

  // Quality: Sharp from Tweaks, remembered.
  await page.click('#dkTweaks');
  await sleep(300);
  await page.click('#qualityGroup input[value="sharp"]');
  assert.equal(await hidden(page, 'qFastWrap'), false, '60 frames a second, on a PC that offers it');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'quality')`);
  const ctl = (await messages(page, n)).filter(m => m.channel === 'control' && m.t === 'quality');
  assert.deepEqual(ctl.map(m => m.preset), ['sharp']);
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem('roost.prefs.v1')).quality`), 'sharp', 'remembered');
  await page.click('#tweaksClose');

  // Connection details: the demo answers pings, so the round trip shows.
  await page.click('#dkTweaks');
  await sleep(300);
  await page.click('#optStats');
  await page.waitFor(`/Round trip\\s*\\d+ ms/.test(document.getElementById('stats').textContent)`, { what: 'stats with RTT' });
  assert.match(await page.text('#stats'), /Picture/);
  assert.ok((await messages(page)).some(m => m.t === 'ping' && m.channel === 'control'), 'pings every 2 s');

  // Refresh the picture from Tweaks: a keyframe, and Tweaks closes.
  n = await count(page);
  await page.click('#optKeyframe');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'keyframe')`);
  assert.equal(await hidden(page, 'tweaks'), true);

  // The Key deck: sticky Win then Tab is Task View (Win+Tab); Desktop is Win+D.
  await page.click('#dkKeys');
  assert.equal(await hidden(page, 'keysBar'), false);
  assert.equal(await page.eval(`document.getElementById('dkKeys').getAttribute('aria-pressed')`), 'true');
  n = await count(page);
  await page.click('#keysBar [data-mod="8"]');
  assert.equal(await page.eval(`document.querySelector('#keysBar [data-mod="8"]').getAttribute('aria-pressed')`), 'true');
  await page.shotAll('viewer-keydeck', { views: { desktop: DESKTOP } });
  await page.click('#keysBar [data-key="tab"]');
  await page.click('#keysBar [data-key="showDesktop"]');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 8`);
  assert.deepEqual(keysOf(await messages(page, n)), [
    'MetaLeft↓8', 'Tab↓8', 'Tab↑8', 'MetaLeft↑0', 'MetaLeft↓8', 'KeyD↓8', 'KeyD↑8', 'MetaLeft↑0']);
  assert.equal(await page.eval(`document.querySelector('#keysBar [data-mod="8"]').getAttribute('aria-pressed')`), 'false', 'sticky key used up');
  // With a mouse the picture makes room for the deck.
  const deck = await rect(page, '#keysBar'), surf = await rect(page, '#surface');
  assert.ok(surf.bottom <= deck.top + 1, `the picture ends above the Key deck (${surf.bottom} vs ${deck.top})`);

  await page.click('#dkFull');
  await page.waitFor(`!!document.fullscreenElement`, { what: 'full screen' });
  // fullscreenchange (which relabels the button) comes a frame after fullscreenElement is set.
  await page.waitFor(`document.getElementById('dkFull').getAttribute('aria-label') === 'Leave full screen'`, { what: 'button relabelled' });
  await page.click('#dkFull');
  await page.waitFor(`!document.fullscreenElement`, { what: 'left full screen' });

  await page.click('#dkBye');
  await page.waitFor(`!document.getElementById('ended').hidden`, { what: 'ended card' });
  await page.shotAll('viewer-ended', { views: { desktop: DESKTOP } });
  await page.eval(`localStorage.clear()`);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('desktop: show one window, fit it to this screen, and go back to the whole screen', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  await floatingDock(page);
  const pick = v => page.eval(`(() => { const s = document.getElementById('optWindow'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); })()`);
  const size = () => page.eval(`[document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]`);
  const n = await count(page);
  await tweaks(page);
  await page.waitFor(`document.getElementById('optWindow').options.length === 3`, { what: 'the list of windows' });
  assert.deepEqual(await page.eval(`[...document.getElementById('optWindow').options].map(o => o.textContent)`),
    ['The whole screen', 'Notepad: Shopping list', 'Microsoft Edge: Roost']);
  assert.equal(await hidden(page, 'optFit'), true, 'nothing to fit yet');

  await pick('11');
  await page.waitFor(`document.getElementById('video').videoWidth === 900`, { what: 'the picture in the window\'s shape' });
  assert.deepEqual(await size(), [900, 620]);
  assert.equal(await hidden(page, 'optFit'), false);
  await page.shot('viewer-demo-one-window-desktop');

  // Fit: the window takes this screen's shape, so the picture fills it.
  await page.click('#optFit');
  await page.waitFor(`(() => { const v = document.getElementById('video'); return Math.abs(v.videoWidth / v.videoHeight - innerWidth / innerHeight) < 0.01; })()`,
    { what: 'a picture the shape of this screen' });
  assert.equal(await hidden(page, 'tweaks'), true);
  const ctl = (await messages(page, n)).filter(m => m.channel === 'control' && ['windows', 'window', 'fit'].includes(m.t));
  assert.deepEqual(ctl.map(m => [m.t, m.id ?? null]), [['windows', null], ['window', 11], ['fit', null]]);
  assert.deepEqual([ctl[2].w, ctl[2].h], await page.eval(`[innerWidth, innerHeight]`));

  // The PC says the window has gone (it was closed): the picker goes back to the whole screen by itself.
  await sleep(1600);
  await page.eval(`window.__roost.demoSession.onmessage({ t: 'status', window: null })`);
  assert.equal(await page.eval(`document.getElementById('optWindow').value`), '');
  assert.equal(await hidden(page, 'optFit'), true);

  // The Command palette lists the windows too; choosing "Show the whole screen" asks for it.
  await page.click('#dkPalette');
  await page.waitFor(`!!document.querySelector('#paletteList [data-id="window-12"]')`, { what: 'the windows in the palette' });
  await page.type('edge roost');
  await page.key('Enter', 'Enter');
  await page.waitFor(`document.getElementById('video').videoWidth === 1200`, { what: 'the second window' });
  await pick('');
  await page.waitFor(`document.getElementById('video').videoWidth === 756`, { what: 'the whole screen again' });
  assert.equal((await messages(page, n)).filter(m => m.t === 'window').at(-1).id, null);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('the Dock: shrink it to the orb and back; move it from Tweaks; Task Manager and Alt+F4 from Tweaks', async () => {
  const page = await openPage(stack, demoUrl({ log: '0' }));
  await ready(page);
  // The orb: the Dock shrinks to one glowing button, the picture gets the whole window, and a tap brings it back.
  await page.click('#dkOrb');
  await sleep(300);
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('dock-orb')`), true);
  assert.equal(await hidden(page, 'orb'), false);
  assert.equal(await page.eval(`getComputedStyle(document.getElementById('dock')).visibility`), 'hidden');
  assert.equal(await page.eval(`document.getElementById('surface').getBoundingClientRect().top`), 0, 'the picture fills the window');
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem('roost.prefs.v1')).dockOrb`), true, 'remembered');
  await page.shotAll('viewer-orb', { views: { desktop: DESKTOP } });
  await page.click('#orb');
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('dock-orb')`), false);
  assert.equal(await hidden(page, 'orb'), true);

  // Move it to the left from the position grid in Tweaks: it stands up there, and the picture sits beside it.
  await tweaks(page);
  await page.click('#dockPos [data-at="left"]');
  await page.waitFor(`document.getElementById('viewer').classList.contains('at-left') && document.getElementById('viewer').classList.contains('dock-vertical')`, { what: 'the Dock on the left' });
  assert.equal(await page.eval(`document.querySelector('#dockPos [data-at="left"]').getAttribute('aria-checked')`), 'true');
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('tweaks-left')`), false, 'Tweaks on the other side');
  await page.eval(`window.__roost.viewer._toggleTweaks(false)`);
  await sleep(300);
  const r = await rect(page, '#dock');
  assert.ok(r.left < 30 && r.height > r.width, `a tall Dock at the left edge: ${JSON.stringify(r)}`);
  assert.ok(await page.eval(`document.getElementById('surface').getBoundingClientRect().left`) >= r.right, 'the picture beside it');
  await page.shotAll('viewer-dock-left', { views: { desktop: DESKTOP } });
  // On the right, Tweaks opens on the left.
  await page.eval(`window.__roost.viewer._moveDock('right')`);
  await tweaks(page);
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('tweaks-left')`), true);
  const tw = await rect(page, '#tweaks');
  assert.ok(tw.left < 40, 'Tweaks on the left');
  await page.shot('viewer-dock-right-tweaks-left');

  // Task Manager: Ctrl+Shift+Esc (Ctrl+Alt+Del can't be pressed by a program); and Alt+F4.
  let n = await count(page);
  await page.click('#optForceQuit');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 6`, { what: 'the keys' });
  assert.deepEqual(keysOf(await messages(page, n)), ['ControlLeft↓2', 'ShiftLeft↓3', 'Escape↓3', 'Escape↑3', 'ShiftLeft↑2', 'ControlLeft↑0']);
  n = await count(page);
  await tweaks(page);
  await page.click('#optCloseApp');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 4`, { what: 'Alt+F4' });
  assert.deepEqual(keysOf(await messages(page, n)), ['AltLeft↓4', 'F4↓4', 'F4↑4', 'AltLeft↑0']);
  assert.ok(await page.eval(`!!document.querySelector('#keysBar [data-key="taskManager"]')`), 'Task Manager on the Key deck too');
  await page.eval(`localStorage.clear()`);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('status notes: locked, view only, slow link, no screen', async () => {
  const page = await openPage(stack, demoUrl({ locked: '1', viewonly: '1' }));
  await ready(page);
  const ids = () => page.eval(`[...document.querySelectorAll('#banners .banner')].map(b => b.dataset.id)`);
  assert.deepEqual(await ids(), ['locked', 'viewonly']);
  assert.match(await page.text('#banners'), /Your PC is locked/);
  assert.match(await page.text('#banners'), /View only/);
  // View only: clicks send nothing.
  const n = await count(page);
  await page.click(null, { x: 640, y: 420 });
  await sleep(200);
  assert.deepEqual(without(await messages(page, n), 'ping'), []);
  await page.eval(`window.__roost.demoSession.onmessage({ t: 'status', link: 'slow' })`);
  await page.eval(`window.__roost.demoSession.onmessage({ t: 'error', code: 'no-screen-permission', message: 'x' })`);
  assert.deepEqual(await ids(), ['locked', 'viewonly', 'slow', 'error']);
  assert.match(await page.text('#banners'), /Control admin apps/);
  await page.shotAll('viewer-banners', { views: { desktop: DESKTOP, phone: PHONE } });
  // "Use Smooth" on the slow note switches quality.
  const m0 = await count(page);
  await page.click('#banners [data-id="slow"] .btn');
  await page.waitFor(`window.__roost.demoMessages.slice(${m0}).some(m => m.t === 'quality' && m.preset === 'smooth')`);
  await page.eval(`window.__roost.demoSession.onmessage({ t: 'status', locked: false, input: true, link: 'good' })`);
  assert.deepEqual(await ids(), ['error']);
  await page.eval(`localStorage.clear()`);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('Windows keyboard: Ctrl is Ctrl; "⌘ is Ctrl" is off by default there and swaps Control and Win when on', async () => {
  const page = await openPage(stack, demoUrl(), { ua: UA.windowsChrome });
  await ready(page);
  assert.equal(await page.eval(`document.getElementById('optSwap').checked`), false);
  await page.click(null, { x: 640, y: 400 });
  let n = await count(page);
  await page.keyDown('Control', 'ControlLeft', 2);
  await page.key('c', 'KeyC', { modifiers: 2 });
  await page.keyUp('Control', 'ControlLeft', 0);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 4`);
  assert.deepEqual(keysOf(await messages(page, n)), ['ControlLeft↓2', 'KeyC↓2', 'KeyC↑2', 'ControlLeft↑0'], 'Ctrl+C arrives as Ctrl+C');
  // Turned on in Tweaks: Control goes as the Windows key.
  await tweaks(page);
  await page.click('#optSwap');
  await page.click(null, { x: 640, y: 400 });
  n = await count(page);
  await page.keyDown('Control', 'ControlLeft', 2);
  await page.keyUp('Control', 'ControlLeft', 0);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 2`);
  assert.deepEqual(keysOf(await messages(page, n)), ['MetaLeft↓8', 'MetaLeft↑0']);
  await page.eval(`localStorage.clear()`);
  await page.close();
});

test('phone: tapping a text box on the PC brings up the keyboard (Android) or asks for one tap (iPhone)', async () => {
  // The demo's pretend text box is the top half of the PC's screen; the picture fills the middle of the phone.
  const pic = async () => page.eval(`(() => { const r = document.getElementById('video').getBoundingClientRect();
    const v = document.getElementById('video'); const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const h = v.videoHeight * s; const top = r.top + (r.height - h) / 2; return { top, h }; })()`);
  let page = await openPage(stack, demoUrl({ log: '0' }), { view: PHONE, ua: UA.android, name: 'android-kbd' });
  await ready(page);
  let p = await pic();
  await page.tap(195, p.top + p.h * 0.2);
  await page.waitFor(`document.activeElement === document.getElementById('softkbd')`, { what: 'the keyboard, by itself' });
  assert.equal(await page.eval(`document.getElementById('kbdFab').classList.contains('open')`), true);
  // A tap outside any text box puts it away again, because it came up by itself.
  await sleep(300);
  await page.tap(195, p.top + p.h * 0.9);
  await page.waitFor(`document.activeElement !== document.getElementById('softkbd')`, { what: 'the keyboard put away' });
  assert.deepEqual(page.problems(), []);
  await page.close();

  page = await openPage(stack, demoUrl({ log: '0' }), { view: PHONE, ua: UA.iphone, name: 'iphone-kbd' });
  await ready(page);
  p = await pic();
  await page.tap(195, p.top + p.h * 0.2);
  await page.waitFor(`document.getElementById('kbdFab').classList.contains('invite')`, { what: 'the "Tap to type" button' });
  assert.equal(await page.text('#kbdFabLabel'), 'Tap to type');
  assert.notEqual(await page.eval(`document.activeElement?.id`), 'softkbd', 'not opened without a tap of its own');
  await page.shot('viewer-demo-tap-to-type-phone');
  const fab = await page.eval(`(() => { const r = document.getElementById('kbdFab').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.tap(fab.x, fab.y);
  await page.waitFor(`document.activeElement === document.getElementById('softkbd')`, { what: 'the keyboard after one tap' });
  assert.equal(await page.eval(`document.getElementById('kbdFab').classList.contains('invite')`), false);
  // A locked PC: the button asks for the password, and stays until it's tapped.
  await page.eval(`document.getElementById('softkbd').blur()`);
  await page.eval(`window.__roost.demoSession.onmessage({ t: 'status', locked: true })`);
  assert.equal(await page.text('#kbdFabLabel'), 'Tap to type the password');
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('phone: the Dock at the bottom shrinks to an orb; the palette and Tweaks come up from the bottom', async () => {
  const page = await openPage(stack, demoUrl({ log: '0' }), { view: PHONE, ua: UA.iphone, name: 'phone-dock' });
  await ready(page);
  const root = cls => page.eval(`document.getElementById('viewer').classList.contains('${cls}')`);
  assert.equal(await root('at-bottom'), true, 'at the bottom, in reach of a thumb');
  const dock = await rect(page, '#dock');
  assert.ok(dock.left >= 12 && dock.right <= 390 - 12, `inside the 16px-ish gutters: ${JSON.stringify(dock)}`);
  assert.equal(await page.eval(`document.documentElement.scrollWidth <= innerWidth`), true, 'no sideways scrolling');
  // Each button big enough for a thumb.
  const small = await page.eval(`[...document.querySelectorAll('#dock .dk')].filter(b => b.offsetParent).map(b => b.getBoundingClientRect()).filter(r => r.width < 40 || r.height < 40).length`);
  assert.equal(small, 0);
  await page.shotAll('viewer-dock-phone', { views: { phone: PHONE } });
  // Not used for a while: it shrinks to the orb.
  await page.waitFor(`document.getElementById('viewer').classList.contains('dock-orb')`, { timeoutMs: 8000, what: 'the orb' });
  await page.shot('viewer-orb-phone');
  const orb = await page.center('#orb');
  await page.tap(orb.x, orb.y);
  await page.waitFor(`!document.getElementById('viewer').classList.contains('dock-orb')`, { what: 'the Dock back' });
  await sleep(300); // it grows back out of the orb
  // The Command palette: a sheet from the bottom, without the keyboard popping up over it.
  const pal = await page.center('#dkPalette');
  await page.tap(pal.x, pal.y);
  await page.waitFor(`!document.getElementById('palette').hidden`, { what: 'the palette' });
  await sleep(350); // it slides up
  assert.notEqual(await page.eval(`document.activeElement.id`), 'paletteInput');
  const sheet = await rect(page, '#palette');
  assert.ok(Math.abs(sheet.bottom - 844) < 2 && sheet.left === 0 && sheet.width === 390, `a bottom sheet: ${JSON.stringify(sheet)}`);
  await page.shotAll('viewer-palette-phone', { views: { phone: PHONE } });
  await page.tap(195, 100); // the scrim closes it
  await page.waitFor(`document.getElementById('palette').hidden`, { what: 'palette closed' });
  await page.eval(`window.__roost.viewer._toggleTweaks(true)`);
  await sleep(300);
  await page.shotAll('viewer-tweaks-phone', { views: { phone: PHONE } });
  await page.eval(`localStorage.clear()`);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('phone: touchpad mode moves the PC’s pointer by how far the finger goes, and taps click where it is', async () => {
  const page = await openPage(stack, demoUrl({ log: '0' }), { view: PHONE, ua: UA.iphone, name: 'touchpad' });
  await ready(page);
  await tweaks(page);
  assert.equal(await hidden(page, 'touchpadWrap'), false);
  await page.click('#optTouchpad');
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem('roost.prefs.v1')).touchpad`), true, 'remembered');
  await page.eval(`window.__roost.viewer._toggleTweaks(false)`);
  const [sw] = await page.eval(`window.__roost.viewer.pointer.shownSize()`);
  // Wherever the finger is, the PC's pointer starts from where it was (the middle) and moves by the same amount.
  let n = await count(page);
  await page.touch('touchStart', [{ x: 60, y: 500 }]);
  for (let x = 70; x <= 110; x += 10) { await page.touch('touchMove', [{ x, y: 500 }]); await sleep(20); }
  await page.touch('touchEnd', []);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'm')`, { what: 'pointer moves' });
  await sleep(100);
  const last = (await messages(page, n)).filter(m => m.t === 'm').at(-1);
  assert.ok(Math.abs(last.x - (0.5 + 50 * 1.6 / sw)) < 0.01, `pointer at ${last.x}`);
  assert.ok(Math.abs(last.y - 0.5) < 0.01);
  // A tap far away clicks where the PC's pointer is.
  await sleep(500);
  n = await count(page);
  await page.tap(300, 1500 / 2);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`, { what: 'the click' });
  const clicks = (await messages(page, n)).filter(m => m.t === 'b');
  assert.ok(clicks.every(c => Math.abs(c.x - last.x) < 1e-9 && Math.abs(c.y - last.y) < 1e-9), JSON.stringify(clicks));
  await page.eval(`localStorage.clear()`);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('phone: taps, double taps, long press, two-finger scroll, pinch zoom, the phone keyboard and the Key deck', async () => {
  const page = await openPage(stack, demoUrl(), { view: PHONE, ua: UA.iphone });
  await ready(page);
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('touch')`), true);
  assert.equal(await hidden(page, 'kbdFab'), false, 'keyboard button on a phone');
  await page.shot('viewer-demo-dock-phone');

  // Tap in the middle of the picture → a left click there.
  let n = await count(page);
  await page.tap(195, 422);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`, { what: 'tap' });
  let want = await expected(page, 195, 422);
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'b').map(({ b, d, n: c, x, y }) => ({ b, d, n: c, x, y })), [
    { b: 0, d: true, n: 1, x: want.x, y: want.y }, { b: 0, d: false, n: 1, x: want.x, y: want.y }]);

  // Double tap → the second click has count 2.
  await sleep(500);
  n = await count(page);
  await page.tap(150, 400);
  await sleep(60);
  await page.tap(153, 402);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 4`, { what: 'double tap' });
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'b').map(m => `${m.d ? '↓' : '↑'}${m.n}`), ['↓1', '↑1', '↓2', '↑2']);

  // Long press → right click while the finger is still down.
  await sleep(500);
  n = await count(page);
  await page.touch('touchStart', [{ x: 250, y: 380 }]);
  await sleep(800);
  await page.touch('touchEnd', []);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`, { what: 'long press' });
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'b').map(m => [m.b, m.d]), [[2, true], [2, false]]);

  // Two fingers moving up → scroll the PC (positive dy).
  n = await count(page);
  await page.touch('touchStart', [{ x: 150, y: 450, id: 0 }, { x: 240, y: 450, id: 1 }]);
  for (let i = 1; i <= 6; i++) {
    await page.touch('touchMove', [{ x: 150, y: 450 - 12 * i, id: 0 }, { x: 240, y: 450 - 12 * i, id: 1 }]);
    await sleep(20);
  }
  await page.touch('touchEnd', []);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'w')`, { what: 'two-finger scroll' });
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
  assert.deepEqual(without(await messages(page, n), 'ping', 'm'), [], 'zooming sends nothing to the PC');
  await page.shot('viewer-demo-zoomed-phone');
  await sleep(500);
  n = await count(page);
  await page.tap(100, 300);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`);
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

  // The keyboard button that is always on screen: its text box takes the tap itself (what iPhones need to open the
  // keyboard), the Key deck comes up with the keyboard, and a second tap closes both.
  await page.tap(...Object.values(await page.center('#kbdFab')).slice(0, 2));
  await page.waitFor(`document.activeElement === document.getElementById('softkbd')`, { what: 'keyboard opened from the button' });
  assert.equal(await page.eval(`document.getElementById('kbdFab').classList.contains('open')`), true);
  assert.equal(await hidden(page, 'keysBar'), false, 'the Key deck comes up with the keyboard');
  n = await count(page);
  await page.type('héllo 👋');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'txt')`, { what: 'typed text' });
  assert.equal((await messages(page, n)).filter(m => m.t === 'txt').map(m => m.s).join(''), 'héllo 👋');
  n = await count(page);
  await page.key('Backspace', 'Backspace');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'k' && m.c === 'Backspace')`, { what: 'backspace' });
  // Sticky Ctrl on the deck, then "c" typed on the phone keyboard: the shortcut Ctrl+C, not the letter.
  n = await count(page);
  await page.tap(...Object.values(await page.center('#keysBar [data-mod="2"]')).slice(0, 2));
  assert.equal(await page.eval(`document.activeElement === document.getElementById('softkbd')`), true, 'the deck keeps the keyboard open');
  await page.type('c');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 4`, { what: 'Ctrl+C' });
  assert.deepEqual(keysOf(await messages(page, n)), ['ControlLeft↓2', 'KeyC↓2', 'KeyC↑2', 'ControlLeft↑0']);
  // Tapping the PC's picture (to put the cursor in a text field there) must not close the keyboard.
  n = await count(page);
  await page.tap(195, 300);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'b').length >= 2`, { what: 'the tap as a click' });
  assert.equal(await page.eval(`document.activeElement === document.getElementById('softkbd')`), true, 'keyboard still open after a tap');
  await page.shotAll('viewer-keydeck-phone', { views: { phone: PHONE } });
  await page.setView({ view: PHONE_LANDSCAPE });
  await page.shot('viewer-demo-keydeck-phone-landscape');
  await page.setView({ view: PHONE });
  await page.tap(...Object.values(await page.center('#kbdFab')).slice(0, 2));
  await page.waitFor(`document.activeElement !== document.getElementById('softkbd')`, { what: 'keyboard closed by a second tap' });
  assert.equal(await hidden(page, 'keysBar'), true, 'the Key deck goes away with it');
  assert.deepEqual(page.problems(), []);
  await page.close();
});

test('desktop: drag the Dock to any corner, choose the Key deck’s keys, swipes, a hidden pointer and the PC’s very edge', async () => {
  const page = await openPage(stack, demoUrl());
  await ready(page);
  const win = await page.eval(`({ w: innerWidth, h: innerHeight })`);

  // Drag the grip to the bottom left: the Dock snaps into that corner, and the picture sits above it.
  const grip = await page.center('#dockGrip');
  await page.mouse('mouseMoved', grip.x, grip.y);
  await page.mouse('mousePressed', grip.x, grip.y, { button: 'left', clickCount: 1 });
  await page.mouse('mouseMoved', 300, win.h - 300, { buttons: 1 });
  await page.mouse('mouseMoved', 120, win.h - 40, { buttons: 1 });
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('dragging')`), true);
  await page.shot('viewer-dock-dragging');
  await page.mouse('mouseReleased', 120, win.h - 40, { button: 'left', clickCount: 1 });
  await sleep(350); // its glide into place
  let dock = await rect(page, '#dock'), surf = await rect(page, '#surface');
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem('roost.prefs.v1')).dockAt`), 'bottom-left', 'remembered');
  assert.ok(Math.abs(dock.bottom - (win.h - 12)) < 2 && Math.abs(dock.left - 12) < 2, `in the corner: ${JSON.stringify(dock)}`);
  assert.ok(surf.bottom <= dock.top, 'the picture ends above the Dock');
  await page.shotAll('viewer-dock-bottom-left', { views: { desktop: DESKTOP } });

  // From the keyboard: arrow keys on the grip move it to the next place.
  await page.eval(`document.getElementById('dockGrip').focus()`);
  await page.key('ArrowRight', 'ArrowRight');
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('at-bottom')`), true);
  await page.key('ArrowUp', 'ArrowUp');
  assert.equal(await page.eval(`document.getElementById('viewer').classList.contains('at-top')`), true, 'over the middle, to the top');
  await sleep(300); // its glide

  // The very bottom row of the picture is the PC's very bottom (where the taskbar waits).
  await page.eval(`(() => { const v = window.__roost.viewer; v.prefs.set('dockRoom', true); v._placeDock(); })()`);
  surf = await rect(page, '#surface');
  const pic = await page.eval(`(() => { const v = document.getElementById('video'); return { w: v.videoWidth, h: v.videoHeight }; })()`);
  const scale = Math.min(surf.width / pic.w, surf.height / pic.h);
  const picBottom = surf.top + (surf.height + pic.h * scale) / 2;
  let n = await count(page);
  await page.mouse('mouseMoved', surf.left + surf.width / 2, Math.floor(picBottom) - 1);
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'm')`);
  assert.equal((await messages(page, n)).filter(m => m.t === 'm').at(-1).y, 1);

  // Choose keys: F5 onto the deck (Task Manager is there already), and a homemade one (Ctrl+K).
  await page.click('#dkKeys');
  await page.click('#keysEdit');
  assert.equal(await hidden(page, 'keysEditor'), false);
  await page.shotAll('viewer-keys-editor', { views: { desktop: DESKTOP, phone: PHONE } });
  await page.click('#keysGroups .ke-item[data-id="f5"]');
  assert.equal(await page.eval(`document.querySelector('#keysGroups .ke-item[data-id="f5"]').getAttribute('aria-pressed')`), 'true');
  await page.eval(`(() => { document.getElementById('keOwnKey').value = 'KeyK'; })()`);
  await page.click('#keOwnAdd');
  await page.click('#keysEditorDone');
  assert.equal(await hidden(page, 'keysEditor'), true);
  n = await count(page);
  await page.click('#keysBar [data-key="taskManager"]');
  await page.click('#keysBar [data-key="f5"]');
  await page.click('#keysBar [data-key="c:Ctrl+KeyK"]');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'k').length >= 12`);
  assert.deepEqual(keysOf(await messages(page, n)), [
    'ControlLeft↓2', 'ShiftLeft↓3', 'Escape↓3', 'Escape↑3', 'ShiftLeft↑2', 'ControlLeft↑0',
    'F5↓0', 'F5↑0', 'ControlLeft↓2', 'KeyK↓2', 'KeyK↑2', 'ControlLeft↑0']);
  await page.shot('viewer-keydeck-chosen');

  // The PC's own controls: brightness goes as special keys, not shortcuts (no sound or media keys).
  await page.click('#keysEdit');
  assert.ok(await page.eval(`[...document.querySelectorAll('#keysGroups .ke-group h3')].some(e => /PC controls/.test(e.textContent))`),
    'a "PC controls" group in the chooser');
  await page.click('#keysGroups .ke-item[data-id="brightnessUp"]');
  await page.click('#keysGroups .ke-item[data-id="brightnessDown"]');
  await page.click('#keysEditorDone');
  n = await count(page);
  await page.click('#keysBar [data-key="brightnessUp"]');
  await page.click('#keysBar [data-key="brightnessDown"]');
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).filter(m => m.t === 'sys').length >= 2`, { what: 'special keys' });
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'sys' || m.t === 'k').map(m => m.t === 'sys' ? m.k : m.c), ['brightnessUp', 'brightnessDown']);
  assert.ok(!(await page.eval(`[...document.querySelectorAll('#keysGroups .ke-item b')].some(b => /Vol|Mute|⏯|⏭|⏮|Keys light/.test(b.textContent))`)),
    'no volume, media or keyboard-light keys to choose');

  // A two-finger swipe sideways on a touchpad: Alt held, Tab pressed (the app switcher), Alt let go a moment later.
  surf = await rect(page, '#surface');
  n = await count(page);
  const mid = { x: surf.left + surf.width / 2, y: surf.top + surf.height / 2 };
  for (let i = 0; i < 8; i++) { await page.mouse('mouseWheel', mid.x, mid.y, { deltaX: 40, deltaY: 0 }); await sleep(16); }
  await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'k' && m.c === 'AltLeft' && !m.d)`, { what: 'Alt let go', timeoutMs: 3000 });
  const sw = (await messages(page, n)).filter(m => m.t === 'k' || m.t === 'w');
  assert.deepEqual(sw.map(m => m.t === 'w' ? 'w' : `${m.c}${m.d ? '↓' : '↑'}`), ['AltLeft↓', 'Tab↓', 'Tab↑', 'AltLeft↑'], 'a swipe, not a scroll');

  // Hide this computer's pointer; Esc twice brings it back (the first Esc still reaches the PC).
  await tweaks(page);
  await page.click('#optHideCursor');
  await page.eval(`window.__roost.viewer._toggleTweaks(false)`);
  assert.equal(await page.eval(`getComputedStyle(document.getElementById('surface')).cursor`), 'none');
  await page.eval(`document.getElementById('surface').focus()`);
  n = await count(page);
  await page.key('Escape', 'Escape');
  await page.key('Escape', 'Escape');
  assert.notEqual(await page.eval(`getComputedStyle(document.getElementById('surface')).cursor`), 'none');
  assert.deepEqual((await messages(page, n)).filter(m => m.t === 'k').map(m => `${m.c}${m.d ? '↓' : '↑'}`), ['Escape↓', 'Escape↑']);
  await page.eval(`localStorage.removeItem('roost.prefs.v1')`); // the next tests start from the usual
  assert.deepEqual(page.problems(), []);
  await page.close();
});

// The picture's shape: on a screen of another shape (here 4:3, the demo PC is about 3:2), "fill" covers the window and
// slides after the pointer so every edge of the PC can still be reached; "stretch" squeezes it to the window.
test('picture shape: whole, fill (slides after the pointer) and stretch, on a 4:3 screen and a phone', async () => {
  const page = await openPage(stack, demoUrl(), { view: { width: 1024, height: 768, mobile: false } });
  await ready(page);
  await floatingDock(page);
  const fit = () => page.eval(`getComputedStyle(document.getElementById('video')).objectFit`);
  const choose = (p, shape) => p.eval(`(() => { const r = document.querySelector('#shapeGroup input[value="${shape}"]'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
  const moveTo = async (x, y) => {
    const n = await count(page);
    await page.mouse('mouseMoved', x, y);
    await page.waitFor(`window.__roost.demoMessages.slice(${n}).some(m => m.t === 'm')`, { what: 'a pointer move' });
    return (await messages(page, n)).filter(m => m.t === 'm').pop();
  };
  assert.equal(await fit(), 'contain', 'whole screen by default');

  await choose(page, 'fill');
  assert.equal(await fit(), 'cover');
  assert.match(await page.text('#shapeHelp'), /off the sides/);
  const g = await geometry(page);
  const { left, top, width, height } = g.box;
  // The window's edges are the PC's edges, and the middle its middle; the picture slid to show each.
  const l = await moveTo(left + 1, top + height / 2);
  assert.deepEqual([l.x, l.y], [0, 0.5]);
  assert.match(await page.eval(`document.getElementById('video').style.objectPosition`), /^0\.\d+% 50(\.00)?%$/);
  const r = await moveTo(left + width - 1, top + height / 2);
  assert.equal(r.x, 1);
  const at = [left + width * 0.3, top + height * 0.2];
  const m = await moveTo(...at);
  const want = toDisplay(at[0], at[1], g.box, g.vw, g.vh, g.view, 0, { shape: 'fill', pan: followPan(at[0], at[1], g.box) });
  assert.deepEqual([m.x, m.y], [want.x, want.y]);
  assert.ok(Math.abs(m.x - 0.3) < 0.002 && Math.abs(m.y - 0.2) < 0.002, `fill: ${m.x}, ${m.y}`);
  await page.shot('viewer-shape-fill-4x3');

  await choose(page, 'stretch');
  assert.equal(await fit(), 'fill');
  assert.match(await page.text('#shapeHelp'), /squeezed by about \d+%/);
  const s = await moveTo(left + width * 0.25, top + height * 0.75);
  assert.ok(Math.abs(s.x - 0.25) < 0.002 && Math.abs(s.y - 0.75) < 0.002, `stretch: ${s.x}, ${s.y}`);
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem('roost.prefs.v1')).shape`), 'stretch', 'remembered');
  await page.eval(`localStorage.clear()`);

  // A phone held upright: "fill" crops the sides; two fingers drag the picture sideways instead of scrolling the PC.
  const phone = await openPage(stack, demoUrl(), { view: PHONE, ua: UA.iphone, name: 'phone' });
  await ready(phone);
  await choose(phone, 'fill');
  assert.equal(await phone.eval(`getComputedStyle(document.getElementById('video')).objectFit`), 'cover');
  const before = await phone.eval('window.__roost.viewer.pan.x');
  const n = await count(phone);
  await phone.touch('touchStart', [{ x: 150, y: 450, id: 0 }, { x: 240, y: 450, id: 1 }]);
  for (let i = 1; i <= 6; i++) {
    await phone.touch('touchMove', [{ x: 150 + 15 * i, y: 450, id: 0 }, { x: 240 + 15 * i, y: 450, id: 1 }]);
    await sleep(20);
  }
  await phone.touch('touchEnd', []);
  await sleep(200);
  assert.ok(await phone.eval('window.__roost.viewer.pan.x') < before, 'dragged right: the left part comes into view');
  assert.deepEqual((await messages(phone, n)).filter(m => m.t === 'w' || m.t === 'b'), [], 'no scrolling or clicks on the PC');
  await phone.eval(`localStorage.clear()`);
});

// The Dock at the bottom, tucking itself away: it comes back only when the mouse touches the very edge, with no lip in
// the way of clicks, and with the Key deck showing it sits on top of the deck rather than over it.
test('the Dock at the bottom, tucking itself away: back at the very edge only, and above the Key deck', async () => {
  const page = await openPage(stack, demoUrl({ log: '0' }));
  await ready(page);
  const away = () => page.eval(`document.getElementById('viewer').classList.contains('dock-away')`);
  await page.eval(`(() => { const v = window.__roost.viewer; v._moveDock('bottom'); v._setIdle('hide'); })()`);
  await sleep(300); // its glide
  await page.click('#dkKeys');
  await page.waitFor(`!document.getElementById('keysBar').hidden`, { what: 'the Key deck' });
  await sleep(300);
  const dock = await rect(page, '#dock'), keys = await rect(page, '#keysBar');
  assert.ok(dock.bottom <= keys.top + 1, `the Dock sits above the Key deck: ${JSON.stringify({ dock, keys })}`);
  assert.equal(await hidden(page, 'dockLip'), true, 'no lip with a mouse');
  await page.shot('viewer-dock-bottom-deck');
  // Tucked away: the mouse near (but not at) the bottom leaves it there; the very edge brings it back.
  await page.eval(`window.__roost.viewer._idle(true)`);
  assert.equal(await away(), true);
  const H = await page.eval('innerHeight');
  await page.mouse('mouseMoved', 640, H - 30);
  await sleep(150);
  assert.equal(await away(), true, '30px from the edge: still away');
  await page.mouse('mouseMoved', 640, H - 1);
  await page.waitFor(`!document.getElementById('viewer').classList.contains('dock-away')`, { what: 'the Dock back at the edge' });
  await page.eval(`localStorage.clear()`);
  assert.deepEqual(page.problems(), []);
  await page.close();
});

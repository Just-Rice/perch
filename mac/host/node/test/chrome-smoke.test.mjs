// One smoke test with a real browser: headless Chrome pairs with the real host process (src/main.mjs under
// test/fake-app.mjs) and decodes its H.264 video and Opus sound. The viewer is our own tiny page (test/chrome/), not
// the website, which is built separately. Chrome makes a real passkey, but in CDP's virtual authenticator
// (tests/e2e/cdp.mjs), so nothing reaches Touch ID or the Keychain; all rendezvous goes through the local broker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBroker } from '../../../tests/e2e/broker.mjs';
import { launchChrome, collectConsole, autoVirtualAuthenticator, CHROME } from '../../../tests/e2e/cdp.mjs';
import { startHost } from './fake-app.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = { '/shared/': join(HERE, '..', '..', '..', 'site', 'js', 'shared'), '/': join(HERE, 'chrome') };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Serves the test page and the shared modules on 127.0.0.1; the page is opened as localhost (a passkey's RP ID can't
// be an IP address).
function serve() {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const prefix = Object.keys(ROOTS).find(p => path.startsWith(p));
    const name = path.slice(prefix.length);
    // Only plain file names directly inside each root.
    if (!/^[a-z0-9-]+\.(html|js)$/.test(name)) return res.writeHead(404).end();
    const file = join(ROOTS[prefix], name);
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(name)], 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) { try { await fn(); } catch {} } });

test('headless Chrome pairs with the host and decodes its video and sound, and only after the code', {
  skip: existsSync(CHROME) ? false : 'Google Chrome is not installed', timeout: 90_000,
}, async () => {
  const broker = await startBroker();
  cleanups.push(() => broker.close());
  const web = await serve();
  cleanups.push(() => web.close());
  const origin = `http://localhost:${web.port}`;

  // The fake app streams all along, so the host has frames to (not) send before sign-in.
  const app = await startHost({ broker: broker.url, origin, rpId: 'localhost', site: `${origin}/receiver.html`, streamAlways: true });
  cleanups.push(() => app.stop());
  await app.setupTotp();
  const { link } = await app.call('pairStart');

  const chrome = await launchChrome({
    // Raw host addresses rather than mDNS names in Chrome's ICE candidates: werift is on this same Mac.
    extraArgs: ['--mute-audio', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  cleanups.push(() => chrome.close());
  await autoVirtualAuthenticator(chrome.cdp);
  const page = await chrome.cdp.newPage();
  const consoleLog = collectConsole(page);
  const url = `${origin}/receiver.html?brokers=${encodeURIComponent(broker.url)}${new URL(link).hash}`;
  await page.navigate(url);

  const read = () => page.eval('JSON.parse(JSON.stringify(window.__perch))');
  async function until(pred, what, ms = 20_000) {
    const t0 = Date.now();
    for (;;) {
      const s = await read();
      if (s?.error) assert.fail(`page error during ${what}: ${s.error}\n${consoleLog.join('\n')}`);
      if (s && pred(s)) return s;
      if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}; page at ${s?.step}\n${s?.log?.join('\n')}\n${consoleLog.join('\n')}`);
      await sleep(100);
    }
  }

  const atCode = await until(s => s.step === 'code', 'pairing up to the code');
  // Chrome sees the channels as the protocol says, including the unordered, never-retransmitted pointer channel.
  assert.deepEqual(atCode.channels, {
    control: { ordered: true, maxRetransmits: null },
    input: { ordered: true, maxRetransmits: null },
    pointer: { ordered: false, maxRetransmits: 0 },
  });
  for (const kind of ['video', 'audio']) {
    assert.equal(atCode.beforeCode[kind]?.packetsReceived ?? 0, 0, `no ${kind} packets before the code`);
  }
  assert.equal(app.inputs.length, 0);

  await page.eval(`window.__code(${JSON.stringify(await app.freshCode())})`);
  const ready = await until(s => s.step === 'ready', 'signing in');
  assert.equal(ready.paired.name, ready.ready.name);

  const playing = await until(s => s.presented >= 30 && s.stats?.video?.keyFramesDecoded >= 1 && s.stats?.audio?.packetsReceived >= 50,
    'video frames decoded and shown, and audio');
  assert.deepEqual(playing.lastFrame, { width: 640, height: 360 });
  assert.deepEqual([playing.stats.video.frameWidth, playing.stats.video.frameHeight], [640, 360]);
  assert.ok(playing.stats.video.framesDecoded >= 30);

  // Input from a real browser's data channels reaches the app (in echo mode: nothing is actually pressed).
  await page.eval(`window.__send('input', { t: 'k', c: 'KeyH', k: 'h', d: true, m: 0 })`);
  await page.eval(`window.__send('pointer', { t: 'm', x: 0.5, y: 0.25 })`);
  await app.waitFor(() => app.inputs.length >= 2, { what: 'input from Chrome' });
  assert.deepEqual(app.inputs.map(i => i.ev).sort((a, b) => a.t.localeCompare(b.t)),
    [{ t: 'k', c: 'KeyH', k: 'h', d: true, m: 0 }, { t: 'm', x: 0.5, y: 0.25 }]);

  const st = await app.call('state');
  assert.deepEqual([st.state, st.session.viewer, st.devices.length], ['connected', 'Headless Chrome', 1]);
  console.log(`chrome decoded ${playing.stats.video.framesDecoded} frames (${playing.stats.video.keyFramesDecoded} key), ` +
    `${playing.stats.audio.packetsReceived} audio packets, audio level ${playing.stats.audio.audioLevel}`);
});

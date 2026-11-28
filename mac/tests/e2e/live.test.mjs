// Against the PUBLISHED site: a host with production settings (the public brokers, public STUN, origin
// https://just-rice.github.io, RP ID just-rice.github.io) plus the stand-in app, and headless Chrome on the live
// website with a virtual passkey. Only the host's home and secrets are temporary. Skipped unless PERCH_LIVE=1.
//   PERCH_LIVE=1 node --test tests/e2e/live.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openPage, sleep } from '../site/lib/browser.mjs';
import { startHost } from '../../host/node/test/fake-app.mjs';

const LIVE = process.env.PERCH_LIVE === '1';
let stack, app;

test.before(async () => {
  if (!LIVE) return;
  stack = await startStack({ broker: false });
  // Empty values switch the test overrides off, so the host uses its production defaults for everything else.
  app = await startHost({
    broker: '', origin: '', rpId: '', site: '',
    env: { PERCH_BROKERS: '', PERCH_TEST_ORIGIN: '', PERCH_RP_ID: '', PERCH_SITE: '', PERCH_ICE: '' },
  });
  await app.setupTotp();
});
test.after(async () => { await app?.stop(); await stack?.close(); });

test('the live site pairs with and shows a Mac through the public brokers', { skip: !LIVE }, async () => {
  const st = await app.call('state');
  assert.ok(st.rendezvous.filter(b => b.connected).length >= 1, `public brokers: ${JSON.stringify(st.rendezvous)}`);
  const { link } = await app.call('pairStart');
  assert.ok(link.startsWith('https://just-rice.github.io/perch/connect.html#pair='), link);
  const page = await openPage(stack, link, { name: 'live-pair' });
  await page.waitScreen('pair', { timeoutMs: 30000 });
  await page.click('#btnCreate');
  await page.waitScreen('code', { timeoutMs: 30000 });
  await page.click('#code');
  await page.type(await app.freshCode());
  await page.waitScreen('viewer', { timeoutMs: 30000 });
  await page.waitFor(`document.getElementById('video').videoWidth > 0`, { timeoutMs: 30000, what: 'video' });
  const t0 = await page.eval(`document.getElementById('video').currentTime`);
  await sleep(1000);
  assert.ok(await page.eval(`document.getElementById('video').currentTime`) > t0, 'moving picture');
  const box = await page.eval(`(() => { const r = document.getElementById('surface').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const before = app.inputs.length;
  await page.click(null, box);
  await app.waitFor(() => app.inputs.length - before >= 2, { what: 'clicks at the Mac', timeoutMs: 10000 });
  await page.shot('live-viewer');
  assert.deepEqual(page.problems(), []);
});

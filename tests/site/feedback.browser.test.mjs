// The feedback page (site/feedback.html) in a real browser, sending to the real feedback handler
// (feedback/src/handler.js) served on this computer. Cloudflare's robot check is left out (?turnstile=skip, which only
// works on localhost); everything else is as on the real site.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startStack, openPage } from './lib/browser.mjs';
import { handle } from '../../feedback/src/handler.js';

let stack, box, rows;

test.before(async () => {
  stack = await startStack({ broker: false });
  rows = [];
  const deps = {
    allowedOrigins: [stack.base.replace(/\/$/, '')],
    verifyTurnstile: async (token) => ({ success: token === 'test', action: 'feedback' }),
    limit: async () => true,
    store: {
      insert: async (r) => { rows.push(r); },
      countSince: async () => rows.length,
      list: async () => rows,
      update: async () => false,
    },
    digestToken: 'd', adminToken: 'a', now: () => Date.now(),
  };
  box = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const out = await handle(request, deps);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise(r => box.listen(0, '127.0.0.1', r));
});
test.after(async () => { box?.close(); await stack?.close(); });
test.afterEach(async () => { await stack?.closePages(); });

const pageUrl = (hash = '') =>
  `${stack.base}feedback.html?test=1&turnstile=skip&endpoint=${encodeURIComponent(`http://127.0.0.1:${box.address().port}/v1/feedback`)}${hash}`;

test('feedback from the viewer: sent with where it came from, and thanked', async () => {
  const page = await openPage(stack, pageUrl('#from=viewer&v=0.4.1&os=windows'));
  await page.waitFor(`!document.getElementById('fbContext').hidden`, { what: 'the context line' });
  assert.match(await page.text('#fbContext'), /viewer, Perch 0\.4\.1, controlling a Windows PC/);
  await page.click('input[value=bug]');
  await page.click('#fbMessage');
  await page.type('The picture froze when I switched displays.');
  await page.click('#fbContact');
  await page.type('me@example.com');
  await page.click('#fbSend');
  await page.waitFor(`!document.getElementById('fbDone').hidden`, { what: 'thanks' });
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], created_at: undefined }, { created_at: undefined, kind: 'bug',
    message: 'The picture froze when I switched displays.', contact: 'me@example.com', os: 'windows', version: '0.4.1', source: 'viewer' });
  assert.equal(await page.eval(`document.getElementById('fbMessage').value`), '', 'cleared for another');
  await page.shot('feedback-sent-desktop');
  assert.deepEqual(page.problems(), []);
});

test('"Don’t include this" leaves the version and computer out; too short is caught before sending', async () => {
  const page = await openPage(stack, pageUrl('#from=setup&v=0.4.1&os=mac'));
  await page.waitFor(`!document.getElementById('fbContext').hidden`);
  await page.click('#fbContext button');
  assert.match(await page.text('#fbContext'), /won.t be sent/);
  await page.click('#fbSend');
  await page.waitFor(`!document.getElementById('fbError').hidden`, { what: 'too short' });
  assert.match(await page.text('#fbError'), /few words/);
  const before = rows.length;
  await page.click('#fbMessage');
  await page.type('Please add a dark theme toggle.');
  await page.click('#fbSend');
  await page.waitFor(`!document.getElementById('fbDone').hidden`);
  const row = rows[before];
  assert.deepEqual([row.source, row.version, row.os, row.kind], ['setup', null, null, 'idea']);
  assert.deepEqual(page.problems(), []);
});

test('straight from the website: no context line, and the page looks right on a phone', async () => {
  const page = await openPage(stack, pageUrl());
  assert.equal(await page.eval(`document.getElementById('fbContext').hidden`), true);
  await page.shotAll('feedback-page');
  assert.deepEqual(page.problems(), []);
});

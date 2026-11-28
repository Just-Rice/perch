// The Setup server's security rules and API, tested over real HTTP with node:http (fetch won't let a test set the
// Host header, and several tests need to). Run: node --test test/setup-server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSetupServer } from '../src/setup-server.mjs';
import { createMockController } from './setup-mock-controller.mjs';

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data:; style-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// One raw HTTP request. `headers` replace the defaults; a header set to null is left out.
function http(port, method, path, { headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const req = request({ host: '127.0.0.1', port, method, path, headers: h, setHost: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: 'reset', headers: {}, text: '' }) : reject(e)));
    if (body !== undefined) {
      if (chunked) {
        // Write in pieces without a Content-Length, to test the streaming size limit.
        const buf = Buffer.from(body);
        for (let i = 0; i < buf.length; i += 8192) req.write(buf.subarray(i, i + 8192));
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

async function setup(opts = {}) {
  const { controller, mock } = await createMockController({ test: opts.test ?? false });
  const srv = await startSetupServer({ controller, keepAliveMs: opts.keepAliveMs, setupDir: opts.setupDir, opaquePath: opts.opaquePath });
  const port = srv.port;
  const api = (method, path, more = {}) => http(port, method, path, {
    ...more,
    headers: {
      'X-Perch-Key': srv.key,
      ...(method === 'POST' ? { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } : {}),
      ...(more.headers ?? {}),
    },
  });
  return { srv, port, controller, mock, api };
}

function checkSecurityHeaders(res, what) {
  assert.equal(res.headers['content-security-policy'], CSP, `${what}: CSP`);
  assert.equal(res.headers['x-frame-options'], 'DENY', `${what}: X-Frame-Options`);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', `${what}: nosniff`);
  assert.equal(res.headers['referrer-policy'], 'no-referrer', `${what}: Referrer-Policy`);
  assert.equal(res.headers['cache-control'], 'no-store', `${what}: Cache-Control`);
  for (const h of Object.keys(res.headers)) assert.doesNotMatch(h, /^access-control-/, `${what}: no CORS header (${h})`);
}

test('the URL, port and key it hands back', async (t) => {
  const { srv, port } = await setup();
  t.after(() => srv.close());
  assert.match(srv.key, /^[A-Za-z0-9_-]{43}$/, '32 random bytes in base64url');
  assert.equal(srv.url, `http://127.0.0.1:${port}/?k=${srv.key}`);
  const a = await startSetupServer({ controller: (await createMockController()).controller });
  t.after(() => a.close());
  assert.notEqual(a.key, srv.key, 'a new key every start');
  const fixed = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  const b = await startSetupServer({ controller: (await createMockController()).controller, key: fixed });
  t.after(() => b.close());
  assert.equal(b.key, fixed);
  await assert.rejects(startSetupServer({ controller: {}, key: 'short' }), /22 to 128/);
  await assert.rejects(startSetupServer({ controller: {}, key: 'has spaces in it, which is not base64url' }), /base64url/);
  await assert.rejects(startSetupServer({ controller: {}, port: b.port }), /already in use/);
});

test('the page only loads with the right key', async (t) => {
  const { srv, port } = await setup();
  t.after(() => srv.close());
  for (const path of ['/', '/?k=', '/?k=wrong', `/?k=${srv.key}x`, `/?k=${srv.key.slice(1)}`, '/index.html', `/?K=${srv.key}`]) {
    const r = await http(port, 'GET', path);
    assert.equal(r.status, 403, path);
    assert.match(r.text, /menu bar/, `${path}: tells the person where to open Setup`);
    assert.doesNotMatch(r.text, /setup\.js/, `${path}: the real page isn't sent`);
    checkSecurityHeaders(r, path);
  }
  const ok = await http(port, 'GET', `/?k=${srv.key}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /^text\/html/);
  assert.match(ok.text, /<script type="module" src="setup\.js">/);
  checkSecurityHeaders(ok, 'page');
  assert.equal((await http(port, 'GET', `/index.html?k=${srv.key}`)).status, 200);
  assert.equal((await http(port, 'HEAD', `/?k=${srv.key}`)).status, 200);
});

test('requests for any other host name are refused (DNS rebinding)', async (t) => {
  const { srv, port } = await setup();
  t.after(() => srv.close());
  const bad = ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `localhost:${port}0`,
    `127.0.0.2:${port}`, `[::1]:${port}`, `0.0.0.0:${port}`, `127.0.0.1:${port}.evil.example`, ''];
  for (const host of bad) {
    for (const path of [`/?k=${srv.key}`, '/api/state', '/setup.js']) {
      const r = await http(port, 'GET', path, { headers: { Host: host, 'X-Perch-Key': srv.key } });
      assert.ok(r.status === 403 || r.status === 400, `${host} ${path}: ${r.status}`);
      assert.doesNotMatch(r.text, /macName|setup\.js/, `${host} ${path}: nothing leaks`);
    }
  }
  const noHost = await http(port, 'GET', '/api/state', { headers: { Host: null, 'X-Perch-Key': srv.key } });
  assert.ok(noHost.status === 400 || noHost.status === 403, `no Host: ${noHost.status}`);
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
    const r = await http(port, 'GET', '/api/state', { headers: { Host: host, 'X-Perch-Key': srv.key } });
    assert.equal(r.status, 200, host);
  }
});

test('the API needs the key header', async (t) => {
  const { srv, port, api } = await setup();
  t.after(() => srv.close());
  for (const key of [undefined, '', 'wrong', srv.key.toUpperCase(), `${srv.key}x`, `x${srv.key}`, srv.key.slice(0, -1), 'x'.repeat(5000)]) {
    const headers = key === undefined ? {} : { 'X-Perch-Key': key };
    const r = await http(port, 'GET', '/api/state', { headers });
    assert.equal(r.status, 403, `key ${String(key).slice(0, 20)}`);
    assert.match(r.json?.error ?? '', /menu bar/);
    checkSecurityHeaders(r, 'refused API');
    const p = await http(port, 'POST', '/api/reset', {
      headers: { ...headers, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(p.status, 403, `POST with key ${String(key).slice(0, 20)}`);
  }
  // The key in the address bar is only for the page itself, never for the API.
  assert.equal((await http(port, 'GET', `/api/state?k=${srv.key}`)).status, 403);
  const ok = await api('GET', '/api/state');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.macName, 'amber-otter-4821');
  assert.match(ok.headers['content-type'], /^application\/json/);
  checkSecurityHeaders(ok, 'state');
});

test('requests marked as coming from another site are refused', async (t) => {
  const { srv, mock, api } = await setup();
  t.after(() => srv.close());
  for (const site of ['cross-site', 'same-site', 'none']) {
    assert.equal((await api('GET', '/api/state', { headers: { 'Sec-Fetch-Site': site } })).status, 403, site);
  }
  assert.equal((await api('GET', '/api/state', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await api('POST', '/api/reset', { body: '{}', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(mock.callsOf('reset').length, 0);
});

test('POSTs need this page\'s Origin', async (t) => {
  const { srv, port, mock, api } = await setup();
  t.after(() => srv.close());
  const bad = [null, 'null', 'http://evil.example', `http://evil.example:${port}`, `http://127.0.0.1:${port + 1}`,
    `https://127.0.0.1:${port}`, `http://127.0.0.1:${port}/`, `http://localhost`, 'https://just-rice.github.io'];
  for (const origin of bad) {
    const r = await api('POST', '/api/reset', { body: '{}', headers: { Origin: origin } });
    assert.equal(r.status, 403, `Origin ${origin}`);
    assert.ok(r.json?.error);
  }
  assert.equal(mock.callsOf('reset').length, 0, 'nothing ran');
  assert.equal((await api('POST', '/api/pairCancel', { body: '{}', headers: { Origin: `http://localhost:${port}` } })).status, 200);
  assert.equal((await api('POST', '/api/pairCancel', { body: '{}' })).status, 200);
});

test('POSTs must be JSON', async (t) => {
  const { srv, mock, api } = await setup();
  t.after(() => srv.close());
  for (const type of [null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'text/json']) {
    const r = await api('POST', '/api/reset', { body: '{}', headers: { 'Content-Type': type } });
    assert.equal(r.status, 415, `Content-Type ${type}`);
  }
  assert.equal(mock.callsOf('reset').length, 0);
  assert.equal((await api('POST', '/api/pairCancel', { body: '{}', headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status, 200);
  assert.equal((await api('POST', '/api/pairCancel', { body: '{}', headers: { 'Content-Type': 'Application/JSON' } })).status, 200);
  for (const body of ['{', '[]', '"text"', '42', 'null']) {
    const r = await api('POST', '/api/pairCancel', { body });
    assert.equal(r.status, 400, `body ${body}`);
    assert.match(r.json.error, /understood/);
  }
  assert.equal((await api('POST', '/api/pairCancel', { body: '' })).status, 200, 'an empty body is {}');
});

test('bodies over 64 KB are refused, declared or streamed', async (t) => {
  const { srv, mock, api } = await setup();
  t.after(() => srv.close());
  const big = JSON.stringify({ code: 'x'.repeat(65 * 1024) });
  const declared = await api('POST', '/api/totpConfirm', { body: big });
  assert.ok(declared.status === 413 || declared.status === 'reset', `declared: ${declared.status}`);
  const streamed = await api('POST', '/api/totpConfirm', { body: big, chunked: true, headers: { 'Transfer-Encoding': 'chunked' } });
  assert.ok(streamed.status === 413 || streamed.status === 'reset', `streamed: ${streamed.status}`);
  assert.equal(mock.callsOf('totpConfirm').length, 0);
  // Just under the limit gets through to the usual checks (here: the field is too long).
  const under = JSON.stringify({ code: 'x'.repeat(60 * 1024) });
  assert.equal((await api('POST', '/api/totpConfirm', { body: under })).status, 400);
  // And the server is still fine afterwards.
  assert.equal((await api('GET', '/api/state')).status, 200);
});

test('static files: served from the Setup folder, never from outside it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'perch-setup-static-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'setup', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'setup', 'index.html'), '<!doctype html><title>t</title><script type="module" src="setup.js"></script>');
  writeFileSync(join(dir, 'setup', 'setup.js'), 'export {};');
  writeFileSync(join(dir, 'setup', 'lib', 'a.js'), 'export const a = 1;');
  writeFileSync(join(dir, 'setup', '.hidden.js'), 'secret');
  writeFileSync(join(dir, 'setup', 'notes.md'), 'secret');
  writeFileSync(join(dir, 'secret.js'), 'TOP SECRET');
  writeFileSync(join(dir, 'opaque.js'), 'export const opaque = true;');
  symlinkSync(join(dir, 'secret.js'), join(dir, 'setup', 'link.js'));
  const { srv, port } = await setup({ setupDir: join(dir, 'setup'), opaquePath: join(dir, 'opaque.js') });
  t.after(() => srv.close());

  const js = await http(port, 'GET', '/setup.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /^text\/javascript/);
  checkSecurityHeaders(js, 'static');
  assert.equal((await http(port, 'GET', '/lib/a.js')).status, 200);
  const op = await http(port, 'GET', '/vendor/opaque/index.js');
  assert.equal(op.status, 200);
  assert.equal(op.text, 'export const opaque = true;');
  assert.match(op.headers['content-type'], /^text\/javascript/);

  const attempts = ['/../secret.js', '/%2e%2e/secret.js', '/%2E%2E/secret.js', '/lib/../../secret.js', '/lib/%2e%2e/%2e%2e/secret.js',
    '/..%2fsecret.js', '/..%2Fsecret.js', '/%2e%2e%2fsecret.js', '/..%5csecret.js', '/lib%5c..%5c..%5csecret.js', '//secret.js',
    '/.%2e/secret.js', '/secret.js%00.js', '/link.js', '/.hidden.js', '/notes.md', '/lib', '/lib/', '/%', '/%zz',
    '/vendor/opaque/../../../secret.js', `/${'../'.repeat(20)}etc/passwd`, '/nope.js', '/favicon.ico'];
  for (const path of attempts) {
    const r = await http(port, 'GET', path);
    assert.ok([400, 404].includes(r.status), `${path}: ${r.status}`);
    assert.doesNotMatch(r.text, /SECRET|secret|root:/, `${path}: nothing from outside`);
  }
  // Absolute-form targets ("GET http://elsewhere/…") are refused outright.
  const abs = await http(port, 'GET', `http://127.0.0.1:${port}/setup.js`);
  assert.equal(abs.status, 400);
});

test('unknown things are 404s and wrong methods are refused', async (t) => {
  const { srv, port, api } = await setup();
  t.after(() => srv.close());
  for (const name of ['nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'testInputEcho', 'state/x', '']) {
    const r = await api('POST', `/api/${name}`, { body: '{}' });
    assert.equal(r.status, 404, `POST ${name}`);
    assert.ok(r.json?.error, `POST ${name} answers JSON`);
  }
  assert.equal((await api('GET', '/api/nope')).status, 404);
  assert.equal((await api('GET', '/api')).status, 404);
  assert.equal((await api('GET', '/api/reset')).status, 405, 'actions are POST only');
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const r = await http(port, method, '/setup.js');
    assert.equal(r.status, 405, `${method} static`);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const a = await api(method, '/api/state');
    assert.equal(a.status, 405, `${method} API`);
  }
});

test('actions call the controller and answer {result, state}; its errors become 400s', async (t) => {
  const { srv, mock, api } = await setup();
  t.after(() => srv.close());
  const start = await api('POST', '/api/totpStart', { body: '{}' });
  assert.equal(start.status, 200);
  assert.match(start.json.result.uri, /^otpauth:\/\/totp\//);
  assert.match(start.json.result.secret, /^[A-Z2-7]{32}$/);
  assert.equal(start.json.state.macName, 'amber-otter-4821');

  const wrong = await api('POST', '/api/totpConfirm', { body: JSON.stringify({ code: '000000' }) });
  if (wrong.status === 200) assert.fail('a made-up code should not usually match');
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /didn't match/);

  assert.equal((await api('POST', '/api/totpConfirm', { body: '{}' })).status, 400, 'missing field');
  assert.equal((await api('POST', '/api/totpConfirm', { body: '{"code":123456}' })).status, 400, 'wrong type');
  assert.equal((await api('POST', '/api/updateSettings', { body: '{"patch":"x"}' })).status, 400);
  assert.equal((await api('POST', '/api/updateSettings', { body: '{"patch":[]}' })).status, 400);

  const pair = await api('POST', '/api/pairStart', { body: '{}' });
  assert.equal(pair.status, 400);
  assert.equal(pair.json.error, 'Set up the authenticator app first.');

  const s = await api('POST', '/api/updateSettings', { body: JSON.stringify({ patch: { idleMinutes: 30 } }) });
  assert.equal(s.status, 200);
  assert.equal(s.json.result.idleMinutes, 30);
  assert.deepEqual(mock.callsOf('updateSettings').at(-1), ['updateSettings', { idleMinutes: 30 }]);

  const pw = await api('POST', '/api/suggestPassword', { body: '{}' });
  assert.match(pw.json.result, /^[a-z]+(-[a-z]+){4}$/);
  const removed = await api('POST', '/api/deviceRemove', { body: '{"id":"nope"}' });
  assert.equal(removed.json.result, false, 'primitive results come back as they are');
  const nothing = await api('POST', '/api/pairCancel', { body: '{}' });
  assert.equal(nothing.json.result, null, 'no result is null');

  mock.failNext('disconnect', 'Nobody is connected.');
  const d = await api('POST', '/api/disconnect', { body: '{}' });
  assert.equal(d.status, 400);
  assert.deepEqual(d.json, { error: 'Nobody is connected.' });
  assert.equal((await api('POST', '/api/requestPermission', { body: '{"which":"screen"}' })).status, 200);
  assert.deepEqual(mock.callsOf('requestPermission').at(-1), ['requestPermission', 'screen']);
});

test('a controller bug is a 500 with a generic message', async (t) => {
  const controller = {
    state() { throw new TypeError('cannot read properties of undefined (internal detail)'); },
    onChange() { return () => {}; },
  };
  const srv = await startSetupServer({ controller });
  t.after(() => srv.close());
  const r = await http(srv.port, 'GET', '/api/state', { headers: { 'X-Perch-Key': srv.key } });
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.json.error, /internal detail/);
});

test('in an action, a bug is a 500 but a refusal is a 400 with its own words; both are logged at the right level', async (t) => {
  const { controller, mock } = await createMockController();
  controller.disconnect = () => { throw new TypeError('Cannot read properties of undefined (reading \'end\')'); };
  // The host's logger: callable for info, with .warn and .error.
  const lines = [];
  const log = (m) => lines.push(['info', m]);
  log.warn = (m) => lines.push(['warn', m]);
  log.error = (m) => lines.push(['error', m]);
  const srv = await startSetupServer({ controller, log });
  t.after(() => srv.close());
  const headers = { 'X-Perch-Key': srv.key, Origin: `http://127.0.0.1:${srv.port}`, 'Content-Type': 'application/json' };
  const bug = await http(srv.port, 'POST', '/api/disconnect', { headers, body: '{}' });
  assert.equal(bug.status, 500);
  assert.match(bug.json.error, /^Something went wrong in Perch/);
  assert.ok(lines.some(([lvl, m]) => lvl === 'error' && /TypeError: Cannot read properties/.test(m)), 'the details are in the log');
  mock.failNext('pairCancel', 'Nothing to cancel.');
  const refused = await http(srv.port, 'POST', '/api/pairCancel', { headers, body: '{}' });
  assert.deepEqual([refused.status, refused.json], [400, { error: 'Nothing to cancel.' }]);
  assert.ok(lines.some(([lvl, m]) => lvl === 'info' && m === 'pairCancel refused: Nothing to cancel.'));
  await http(srv.port, 'GET', '/api/state', { headers: { 'X-Perch-Key': 'wrong' } });
  await http(srv.port, 'GET', '/api/state', { headers: { Host: 'evil.example', 'X-Perch-Key': srv.key } });
  assert.equal(lines.filter(([lvl]) => lvl === 'warn').length, 2, 'refused requests are warnings');
  assert.ok(lines.every(([, m]) => !m.startsWith('setup:')), 'the host logger adds its own tag');
  assert.ok(lines.every(([, m]) => !m.includes(srv.key)), 'the key is never logged');
});

test('test endpoints exist only in test mode', async (t) => {
  const normal = await setup({ test: false });
  t.after(() => normal.srv.close());
  assert.equal((await normal.api('GET', '/api/test/input-echo')).status, 404);
  assert.equal((await normal.api('GET', '/api/test/state')).status, 404);

  const testing = await setup({ test: true });
  t.after(() => testing.srv.close());
  testing.mock.echo({ t: 'k', c: 'KeyA', k: 'a', d: true, m: 0 });
  const echo = await testing.api('GET', '/api/test/input-echo');
  assert.equal(echo.status, 200);
  assert.deepEqual(echo.json, [{ t: 'k', c: 'KeyA', k: 'a', d: true, m: 0 }]);
  const st = await testing.api('GET', '/api/test/state');
  assert.equal(st.status, 200);
  assert.equal(st.json.test, true);
  assert.equal((await http(testing.port, 'GET', '/api/test/input-echo')).status, 403, 'still needs the key');
});

// Reads Server-Sent Events from /api/events until `until(events)` is true.
function readEvents(port, key, until, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';
    const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}`, 'X-Perch-Key': key } }, (res) => {
      events.headers = res.headers;
      events.status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buffer += d;
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const ev = { comment: block.startsWith(':') };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
            if (line.startsWith('retry: ')) ev.retry = Number(line.slice(7));
          }
          events.push(ev);
          if (until(events, req)) { clearTimeout(timer); req.destroy(); resolve(events); return; }
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve(events); });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`timed out; got ${JSON.stringify(events)}`)); }, timeoutMs);
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}

test('live updates: a snapshot now, one per change, keep-alives, and cleanup', async (t) => {
  const { srv, port, mock } = await setup({ keepAliveMs: 100 });
  t.after(() => srv.close());
  const events = await readEvents(port, srv.key, (evs) => {
    const states = evs.filter(e => e.event === 'state');
    if (states.length === 1 && !evs.done1) {
      evs.done1 = true;
      // Three changes in a row arrive as one update; a no-op change sends nothing.
      setTimeout(() => { mock.setPermissions({ screen: true }); mock.setPermissions({ accessibility: true }); mock.changed(); }, 20);
    }
    return states.length >= 2 && evs.filter(e => e.comment).length >= 2;
  });
  assert.equal(events.status, 200);
  assert.match(events.headers['content-type'], /^text\/event-stream/);
  checkSecurityHeaders({ headers: events.headers }, 'events');
  const states = events.filter(e => e.event === 'state');
  assert.equal(states.length, 2);
  assert.deepEqual(states[0].data.permissions, { screen: false, accessibility: false });
  assert.deepEqual(states[1].data.permissions, { screen: true, accessibility: true });
  assert.ok(events.some(e => e.retry === 2000));
  // The browser going away unsubscribes.
  for (let i = 0; i < 50 && mock.listenerCount > 0; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(mock.listenerCount, 0);

  const refused = await readEvents(port, 'wrong', () => false).catch(e => e);
  assert.equal(refused.status, 403);
});

test('old event streams are closed past the limit, and close() ends them all', async (t) => {
  const { srv, port, mock } = await setup();
  const ended = [];
  for (let i = 0; i < 10; i++) {
    // One at a time, so the server sees them in this order.
    await new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}`, 'X-Perch-Key': srv.key } }, (res) => {
        res.on('data', () => resolve());
        res.on('end', () => { ended.push(i); });
      });
      req.on('error', () => {});
      req.end();
    });
  }
  for (let i = 0; i < 50 && ended.length < 2; i++) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(ended.sort(), [0, 1], 'the two oldest of ten were closed');
  assert.equal(mock.listenerCount, 8);
  await srv.close();
  assert.equal(mock.listenerCount, 0, 'close() unsubscribes every stream');
  await assert.rejects(http(port, 'GET', '/api/state'), /ECONNREFUSED/);
});

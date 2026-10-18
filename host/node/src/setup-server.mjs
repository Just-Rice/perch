// The local Setup page: a tiny web server on 127.0.0.1 that only this Mac can reach.
//
// Setup can pair new devices, so whoever can use it can end up controlling the Mac. Every request therefore has to
// pass these checks, in this order:
//  - the Host header must be 127.0.0.1:<port> or localhost:<port>. A website can point its own domain name at
//    127.0.0.1 ("DNS rebinding") to make the browser treat this server as part of that site; the browser still sends
//    the website's name as the Host, so this check stops it.
//  - the page itself (GET /) only loads with the random key in its address (?k=…), which only Perch's menu bar knows.
//    The page then sends the key in an X-Perch-Key header with every API call, so nothing else on this Mac (another
//    website, another app) can use the API without first reading the key out of Perch.
//  - POSTs must come from this page (Origin), as JSON (a plain HTML form can't send that), and be small.
// Answers never carry CORS headers, and every one carries headers that stop it being framed, sniffed or cached.
//
// The API, all JSON, all with the X-Perch-Key header:
//   GET  /api/state             controller.state()
//   GET  /api/events            Server-Sent Events: `event: state` with a state snapshot now and after every change,
//                               and a keep-alive comment every 15 s. (Read with fetch(), since EventSource can't send
//                               the key header.)
//   POST /api/<action>          one controller method each (see ACTIONS); answers {result, state} or 400 {error}
//   GET  /api/test/state, /api/test/input-echo   only when state().test is true (PERCH_TEST=1)
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SETUP_DIR = path.join(HERE, '..', 'setup');
export const DEFAULT_OPAQUE_PATH = path.join(HERE, '..', '..', '..', 'site', 'js', 'vendor', 'opaque', 'index.js');

const MAX_BODY = 64 * 1024;
const MAX_EVENT_STREAMS = 8;
const KEEPALIVE_MS = 15_000;
const COALESCE_MS = 30;

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data:; " +
    "style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  // Extra belt and braces: other sites can't embed these files or keep a handle on this window.
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
});

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// POST /api/<name>: which controller method each one calls and the body fields it passes along, in order.
// Field rules: 'string' (non-empty, at most 16 KB), 'object' (a plain object).
const ACTIONS = {
  totpStart: [],
  totpConfirm: [['code', 'string']],
  pairStart: [],
  pairCancel: [],
  deviceRename: [['id', 'string'], ['label', 'string']],
  deviceRemove: [['id', 'string']],
  devicesRemoveAll: [],
  suggestPassword: [],
  backupRegisterStart: [['registrationRequest', 'string']],
  backupRegisterFinish: [['registrationRecord', 'string']],
  backupRemove: [],
  relaySet: [['keyId', 'string'], ['apiToken', 'string']],
  relayRemove: [],
  updateSettings: [['patch', 'object']],
  disconnect: [],
  requestPermission: [['which', 'string']],
  newMacName: [],
  reset: [],
  uninstall: [],
  checkForUpdates: [],
  installUpdate: [],
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest();

function checkField(value, rule, name) {
  if (rule === 'string' && typeof value === 'string' && value.length > 0 && value.length <= 16384) return value;
  if (rule === 'object' && value && typeof value === 'object' && !Array.isArray(value)) return value;
  throw new HttpError(400, `Something was missing from that request (${name}). Reload the page and try again.`);
}

function mediaType(header) {
  return String(header ?? '').split(';')[0].trim().toLowerCase();
}

export async function startSetupServer({
  controller, port = 0, key, setupDir = DEFAULT_SETUP_DIR, opaquePath = DEFAULT_OPAQUE_PATH, log = () => {},
  keepAliveMs = KEEPALIVE_MS,
} = {}) {
  if (!controller) throw new Error('startSetupServer needs a controller');
  // `log` may be a plain function or the host's logger (callable, with .warn and .error, and already tagged "setup").
  const warn = typeof log.warn === 'function' ? log.warn : log;
  const error = typeof log.error === 'function' ? log.error : log;
  if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(key))) {
    throw new Error('the Setup key must be 22 to 128 base64url characters');
  }
  key ??= randomBytes(32).toString('base64url');
  const keyHash = sha256(key);
  // Hashing both sides first makes the comparison take the same time whatever the given key's length.
  const keyMatches = (given) => typeof given === 'string' && given.length <= 256 && timingSafeEqual(sha256(given), keyHash);

  const rootReal = await realpath(setupDir);
  let actualPort = port;
  let opaqueFile = null; // the OPAQUE module (about 430 KB), read on first use
  const streams = new Set();

  const allowedHosts = () => [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
  const allowedOrigins = () => allowedHosts().map(h => `http://${h}`);

  // --- responses ---

  function send(res, status, body, type, extra = {}) {
    if (res.headersSent) { res.end(); return; }
    const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': data.length, ...extra });
    res.end(data);
  }
  const sendJson = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
  const sendText = (res, status, text, extra) => send(res, status, text, 'text/plain; charset=utf-8', extra);

  function sendNoKeyPage(res) {
    send(res, 403, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Perch Setup</title>
<link rel="stylesheet" href="/setup.css"><link rel="icon" href="/icon.svg" type="image/svg+xml"></head>
<body><header class="top"><div class="page top-inner"><span class="brand"><img src="/icon.svg" alt="" width="30" height="30">
Perch <span class="brand-sub">Setup</span></span></div></header>
<main class="page"><section class="card blocked" aria-labelledby="t">
<h1 id="t">Open Setup from Perch</h1>
<p>For your safety, Setup only opens from Perch itself. Click the Perch icon in the menu bar at the top of your
screen, then choose <b>Open Setup…</b> from its menu.</p>
<p class="small muted">A Setup tab stops working when Perch restarts. Opening Setup from the menu bar gives you a
fresh one.</p>
</section></main></body></html>`, 'text/html; charset=utf-8');
  }

  // --- the controller, safely ---

  async function currentState() {
    return await controller.state();
  }

  async function stateOrNull() {
    try { return await currentState(); } catch { return null; }
  }

  // --- request handling ---

  async function readJsonBody(req) {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY) throw new HttpError(413, 'That request was too large.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'That request was too large.');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};
    let body;
    try { body = JSON.parse(text); } catch { throw new HttpError(400, 'That request wasn\'t understood. Reload the page and try again.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'That request wasn\'t understood. Reload the page and try again.');
    return body;
  }

  async function runAction(name, body) {
    const args = ACTIONS[name].map(([field, rule]) => checkField(body[field], rule, field));
    if (typeof controller[name] !== 'function') throw new HttpError(404, 'This version of Perch can\'t do that yet.');
    let result;
    try {
      result = await controller[name](...args);
    } catch (e) {
      // The controller refuses things with plain-language messages meant for the person. A TypeError or
      // ReferenceError is a bug instead, and its message ("Cannot read properties of undefined…") would only confuse:
      // that becomes the generic 500 below, with the details in the log.
      if (e instanceof TypeError || e instanceof ReferenceError) throw e;
      log(`${name} refused: ${e?.message || e}`);
      throw new HttpError(400, e?.message || 'Something went wrong. Please try again.');
    }
    return { result: result === undefined ? null : result, state: await stateOrNull() };
  }

  async function handleApi(req, res, pathname) {
    // Browsers label every request with where it came from; anything not from this page itself is refused.
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') throw new HttpError(403, 'Requests from other pages aren\'t allowed.');
    if (!keyMatches(req.headers['x-perch-key'])) {
      throw new HttpError(403, 'This Setup page is out of date. Open Setup again from the Perch icon in the menu bar.');
    }
    const name = pathname.slice('/api/'.length);
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw new HttpError(405, 'That request method isn\'t allowed.');

    if (req.method === 'POST') {
      if (!allowedOrigins().includes(req.headers.origin)) throw new HttpError(403, 'Requests from other pages aren\'t allowed.');
      if (mediaType(req.headers['content-type']) !== 'application/json') throw new HttpError(415, 'Requests must be JSON.');
      if (!Object.hasOwn(ACTIONS, name)) throw new HttpError(404, 'Unknown request.');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await runAction(name, body));
    }

    // GET or HEAD from here on.
    if (Object.hasOwn(ACTIONS, name)) throw new HttpError(405, 'Use POST for that.');
    if (name === 'state') return sendJson(res, 200, await currentState());
    if (name === 'events') return openEventStream(req, res);
    if (name === 'test/state' || name === 'test/input-echo') {
      const state = await currentState();
      if (state?.test !== true) throw new HttpError(404, 'Unknown request.');
      if (name === 'test/state') {
        return sendJson(res, 200, typeof controller.testState === 'function' ? await controller.testState() : state);
      }
      return sendJson(res, 200, await controller.testInputEcho());
    }
    throw new HttpError(404, 'Unknown request.');
  }

  function openEventStream(req, res) {
    // Old tabs left open shouldn't pile up: past the limit, the oldest stream is closed (its page reconnects if it
    // is still alive).
    while (streams.size >= MAX_EVENT_STREAMS) {
      const oldest = streams.values().next().value;
      oldest.close();
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.flushHeaders?.();
    req.socket.setNoDelay?.(true);

    let last = '';
    let timer = null;
    let closed = false;
    const push = async () => {
      timer = null;
      if (closed) return;
      let json;
      try { json = JSON.stringify(await currentState()); } catch (e) { error(`state() failed: ${e?.stack || e}`); return; }
      if (closed || json === last) return;
      last = json;
      res.write(`event: state\ndata: ${json}\n\n`);
    };
    // Several changes in a row (a pairing finishing, say) become one update.
    const schedule = () => { if (!timer && !closed) timer = setTimeout(push, COALESCE_MS); };
    let unsubscribe = () => {};
    try { unsubscribe = controller.onChange(schedule) ?? (() => {}); } catch (e) { error(`onChange() failed: ${e?.stack || e}`); }
    const keepAlive = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, keepAliveMs);

    const stream = {
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        clearInterval(keepAlive);
        try { unsubscribe(); } catch {}
        streams.delete(stream);
        res.end();
      },
    };
    streams.add(stream);
    // (The response's 'close' is what fires when the browser goes away; the request's fires as soon as it's read.)
    res.on('close', () => stream.close());
    res.on('error', () => stream.close());
    res.write('retry: 2000\n\n');
    push();
  }

  // Resolves a URL path to a file inside setupDir, or null. Rejects anything that tries to climb out of it,
  // including through symbolic links, encoded slashes and hidden files.
  async function staticFile(pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const parts = decoded.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some(p => p === '..' || p === '.' || p.startsWith('.'))) return null;
    if (!Object.hasOwn(TYPES, path.extname(parts.at(-1)).toLowerCase())) return null;
    const candidate = path.join(rootReal, ...parts);
    let real;
    try { real = await realpath(candidate); } catch { return null; }
    if (!real.startsWith(rootReal + path.sep)) return null;
    try { if (!(await stat(real)).isFile()) return null; } catch { return null; }
    return real;
  }

  async function sendFile(res, file) {
    send(res, 200, await readFile(file), TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  }

  async function handle(req, res) {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!allowedHosts().includes(host)) {
      warn(`refused a request for host "${host.slice(0, 80)}"`);
      return sendText(res, 403, 'Perch Setup only answers at 127.0.0.1.');
    }
    // Only origin-form targets ("/path?query"); never "http://elsewhere/…" or "*".
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return sendText(res, 400, 'Bad request.');
    const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
    const { pathname } = url;

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      req.isApi = true;
      return handleApi(req, res, pathname);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed.', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
    }
    if (pathname === '/' || pathname === '/index.html') {
      if (!keyMatches(url.searchParams.get('k'))) return sendNoKeyPage(res);
      return sendFile(res, path.join(rootReal, 'index.html'));
    }
    if (pathname === '/vendor/opaque/index.js') {
      opaqueFile ??= await readFile(opaquePath);
      return send(res, 200, opaqueFile, TYPES['.js']);
    }
    const file = await staticFile(pathname);
    if (!file || path.basename(file) === 'index.html') return sendText(res, 404, 'Not found.');
    return sendFile(res, file);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      // A body we refused without reading (too large, wrong page) shouldn't keep the connection busy: close it.
      const extra = req.complete ? {} : { Connection: 'close' };
      let status = 500;
      let message = 'Something went wrong in Perch. Please try again.';
      if (e instanceof HttpError) {
        ({ status, message } = e);
        if (status === 403) warn(`refused ${req.method} ${String(req.url).split('?')[0].slice(0, 80)}: ${message}`);
      } else {
        error(`${req.method} ${String(req.url).split('?')[0].slice(0, 80)} failed: ${e?.stack || e}`);
      }
      if (req.isApi) sendJson(res, status, { error: message }, extra);
      else sendText(res, status, message, extra);
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {} });

  await new Promise((resolve, reject) => {
    const onError = (e) => reject(new Error(e.code === 'EADDRINUSE'
      ? `Setup couldn't start: port ${port} is already in use.` : `Setup couldn't start: ${e.message}`));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(); });
  });
  actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/?k=${key}`;
  log(`listening on 127.0.0.1:${actualPort}`);

  return {
    url,
    port: actualPort,
    key,
    close() {
      for (const s of [...streams]) s.close();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

// A static file server for the website tests: serves site/ at / and the test pages in tests/site/fixtures/ at
// /__test/. Like GitHub Pages it sends "Access-Control-Allow-Origin: *" (which lets module scripts load in sandboxed,
// opaque-origin frames, one of the cases the frame guard has to handle). Bound to 127.0.0.1 only.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SITE = path.resolve(HERE, '../../../site');
export const FIXTURES = path.resolve(HERE, '../fixtures');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.wasm': 'application/wasm', '.sh': 'text/plain; charset=utf-8', '.webp': 'image/webp',
};

export function serveSite({ port = 0 } = {}) {
  const requests = [];
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(`${req.method} ${url.pathname}`);
    let root = SITE;
    let p = decodeURIComponent(url.pathname);
    if (p.startsWith('/__test/')) { root = FIXTURES; p = p.slice('/__test'.length); }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(data);
    } catch (e) {
      res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' }).end(String(e.code || e.message));
    }
  });
  return new Promise(resolve => srv.listen(port, '127.0.0.1', () => resolve({
    port: srv.address().port,
    requests,
    close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  })));
}

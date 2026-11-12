// The relay service as a plain HTTP server on this computer, for other test suites (the Mac host's Setup tests and
// the end-to-end tests): the real handler and ledger, SQLite storage, and a pretend Cloudflare whose usage numbers
// the test sets.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../src/handler.js';
import { LedgerCore, DEFAULT_LIMITS } from '../src/ledger.js';

export async function startLocalRelayService({ ownerKey = 'owner-key-for-local-tests-0123456789', limits = DEFAULT_LIMITS } = {}) {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(q, ...p) {
      const st = db.prepare(q);
      const rows = /^\s*SELECT/i.test(q) ? st.all(...p) : (st.run(...p), []);
      return { toArray: () => rows };
    },
  };
  const svc = { minted: [], revoked: [], usage: {}, ownerKey };
  const turn = {
    async mint({ ttl, customIdentifier }) {
      const username = `local${svc.minted.length + 1}`;
      svc.minted.push({ username, ttl, customIdentifier });
      return { username, iceServers: [{ urls: ['turns:turn.example.invalid:443?transport=tcp'], username, credential: 'pw' }] };
    },
    async revoke(u) { svc.revoked.push(u); },
    async usage({ to }) {
      return { total: { [to]: Object.values(svc.usage).reduce((a, b) => a + b, 0) }, byMac: { [to]: { ...svc.usage } } };
    },
  };
  svc.ledger = new LedgerCore({ sql, turn, limits });
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const r = await handle(new Request(`http://local${req.url}`, {
      method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body } : {}),
    }), { OWNER_KEY: ownerKey }, svc.ledger);
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(await r.text());
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  svc.url = `http://127.0.0.1:${server.address().port}`;
  svc.close = () => new Promise(r => server.close(r));
  return svc;
}

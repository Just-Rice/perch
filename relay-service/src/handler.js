// The relay service's front door: checks each request and hands it to the ledger. Kept apart from worker.js (which
// needs Cloudflare's runtime) so the tests can run it in Node.
import { toB64url, fromB64url } from '../../site/js/shared/bytes.js';
import { REQUEST_VERSION, MAX_SKEW_MS, MAX_BODY_BYTES, requestText, ownerText, REFUSALS } from './request.js';

const enc = new TextEncoder();
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const refuse = (reason, status, extra = {}) => json({ ok: false, reason, message: REFUSALS[reason] ?? REFUSALS.bad, ...extra }, status);

function b64(s, len) {
  if (typeof s !== 'string' || s.length > 200 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const b = fromB64url(s);
    return len && b.length !== len ? null : b;
  } catch { return null; }
}

// The Mac's name in Cloudflare's numbers: a short hash of its relay key (the key itself is never stored there).
export async function identOf(macKey) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', macKey));
  return 'm-' + toB64url(h).slice(0, 22);
}

// Is this the owner? Compares the Mac's HMAC with the owner key's, without the key ever having been sent.
async function isOwner(env, mac, proof) {
  if (!env.OWNER_KEY || typeof env.OWNER_KEY !== 'string' || env.OWNER_KEY.length < 16 || proof == null) return false;
  const sig = b64(proof, 32);
  if (!sig) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(env.OWNER_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(ownerText(mac)));
}

async function ownerBearer(request, env) {
  const auth = request.headers.get('Authorization') ?? '';
  if (!env.OWNER_KEY || env.OWNER_KEY.length < 16 || !auth.startsWith('Bearer ')) return false;
  // Compare digests, so the time taken says nothing about how much of the key was right.
  const [a, b] = await Promise.all([auth.slice(7), env.OWNER_KEY].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// ledger: {issue({ident, owner}), status()} (the Durable Object's stub, or a LedgerCore in tests).
export async function handle(request, env, ledger, now = Date.now()) {
  const url = new URL(request.url);
  if (url.pathname === '/' && request.method === 'GET') {
    return new Response('Perch relay service. See https://github.com/Just-Rice/perch\n', { headers: { 'Content-Type': 'text/plain' } });
  }
  if (url.pathname === '/v1/status' && request.method === 'GET') {
    if (!(await ownerBearer(request, env))) return refuse('bad', 403);
    return json({ ok: true, ...(await ledger.status()) });
  }
  if (url.pathname !== '/v1/ice') return json({ ok: false, reason: 'not-found' }, 404);
  if (request.method !== 'POST') return json({ ok: false, reason: 'method' }, 405);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return refuse('bad', 413);
  let body;
  try { body = JSON.parse(text); } catch { return refuse('bad', 400); }
  if (!body || body.v !== REQUEST_VERSION) return refuse('bad', 400);
  const macKey = b64(body.mac, 32);
  const sig = b64(body.sig, 64);
  if (!macKey || !sig || !Number.isSafeInteger(body.ts) || (body.owner != null && typeof body.owner !== 'string')) {
    return refuse('bad', 400);
  }
  if (Math.abs(now - body.ts) > MAX_SKEW_MS) return refuse('bad', 400, { clock: now });
  let good = false;
  try {
    const key = await crypto.subtle.importKey('raw', macKey, { name: 'Ed25519' }, false, ['verify']);
    good = await crypto.subtle.verify('Ed25519', key, sig, enc.encode(requestText({ mac: body.mac, ts: body.ts, owner: body.owner })));
  } catch { good = false; }
  if (!good) return refuse('bad', 403);

  const owner = await isOwner(env, body.mac, body.owner);
  const ident = await identOf(macKey);
  const r = await ledger.issue({ ident, owner });
  if (!r.ok) return refuse(r.reason, r.reason === 'busy' ? 429 : r.reason === 'turn' ? 502 : 403, { usage: r.usage });
  return json({ ok: true, iceServers: r.iceServers, ttl: r.ttl, usage: r.usage });
}

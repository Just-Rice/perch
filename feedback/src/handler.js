// Perch's feedback box: what people send from the website's feedback page (site/feedback.html), kept in the owner's
// own Cloudflare account and readable only by the owner. index.js wires it to Cloudflare (a D1 database, a rate
// limiter, Turnstile); everything here takes those as plain functions, so tests run it in Node.
//
//   POST  /v1/feedback                {kind, message, contact?, os?, version?, source, turnstile, website}
//         201 {ok: true} once stored. `website` is a field people never see: anything in it means a bot.
//   GET   /v1/admin/feedback?status=&since=   Bearer DIGEST_TOKEN (read only) or ADMIN_TOKEN → {items: [...]}
//   PATCH /v1/admin/feedback/<id>     Bearer ADMIN_TOKEN, {status?, notes?} → {ok: true}
//   anything else: 404
//
// Never stored: the sender's IP address (the rate limiter sees it, briefly, and keeps nothing), browser identity,
// cookies. What is kept is listed on the privacy page.

export const KINDS = ['idea', 'bug', 'other'];
export const SOURCES = ['site', 'viewer', 'setup'];
export const STATUSES = ['new', 'seen', 'approved', 'declined', 'done'];
export const OSES = ['mac', 'windows', 'linux'];
export const MAX_MESSAGE = 4000;
export const MAX_CONTACT = 200;
export const MAX_BODY_BYTES = 8 * 1024;
export const DAILY_CAP = 300;

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

// Same-length comparison that takes as long whatever the inputs (so a token can't be guessed a character at a time).
export function sameToken(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

const clean = (s, max) => (typeof s === 'string' ? s.replace(/\u0000/g, '').trim().slice(0, max) : '');

// deps: {
//   allowedOrigins: [string],             pages allowed to send (the website, and the relay that serves a copy of it)
//   verifyTurnstile(token, ip) → {success, hostname, action}
//   limit(ip) → boolean                   false: too many from this address just now
//   store: {insert(row), countSince(iso), list({status, since}), update(id, {status, notes}) → boolean}
//   digestToken, adminToken, now() → ms
// }
export async function handle(request, deps) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const cors = origin && deps.allowedOrigins.includes(origin)
    ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};

  if (url.pathname === '/v1/feedback') {
    if (request.method === 'OPTIONS') {
      if (!cors['access-control-allow-origin']) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: {
        ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400',
      } });
    }
    if (request.method !== 'POST') return json(405, { error: 'method' }, cors);
    if (!cors['access-control-allow-origin']) return json(403, { error: 'origin' });
    return submit(request, deps, cors);
  }

  if (url.pathname === '/v1/admin/feedback' || url.pathname.startsWith('/v1/admin/feedback/')) {
    const auth = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const admin = sameToken(auth, deps.adminToken);
    const reader = admin || sameToken(auth, deps.digestToken);
    if (!reader) return json(401, { error: 'auth' });
    if (request.method === 'GET' && url.pathname === '/v1/admin/feedback') {
      const status = url.searchParams.get('status');
      const since = url.searchParams.get('since');
      if (status && !STATUSES.includes(status)) return json(400, { error: 'status' });
      if (since && Number.isNaN(Date.parse(since))) return json(400, { error: 'since' });
      return json(200, { items: await deps.store.list({ status: status || null, since: since || null }) });
    }
    const m = /^\/v1\/admin\/feedback\/(\d{1,12})$/.exec(url.pathname);
    if (request.method === 'PATCH' && m) {
      if (!admin) return json(403, { error: 'read-only token' });
      let body;
      try { body = await request.json(); } catch { return json(400, { error: 'json' }); }
      const patch = {};
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) return json(400, { error: 'status' });
        patch.status = body.status;
      }
      if (body.notes !== undefined) patch.notes = clean(body.notes, 2000);
      if (!Object.keys(patch).length) return json(400, { error: 'nothing to change' });
      return (await deps.store.update(Number(m[1]), patch)) ? json(200, { ok: true }) : json(404, { error: 'no such item' });
    }
    return json(404, { error: 'not found' });
  }
  return json(404, { error: 'not found' });
}

async function submit(request, deps, cors) {
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) return json(413, { error: 'too-big' }, cors);
  let raw;
  try { raw = await request.text(); } catch { return json(400, { error: 'body' }, cors); }
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'too-big' }, cors);
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'json' }, cors); }
  if (!body || typeof body !== 'object') return json(400, { error: 'json' }, cors);

  // A bot that filled in the hidden field: say thanks, keep nothing.
  if (typeof body.website === 'string' && body.website.trim()) return json(201, { ok: true }, cors);

  const message = clean(body.message, MAX_MESSAGE + 1);
  if (message.length < 3) return json(400, { error: 'message', detail: 'Write a few words first.' }, cors);
  if (message.length > MAX_MESSAGE) return json(400, { error: 'message', detail: `Keep it under ${MAX_MESSAGE} characters.` }, cors);
  const kind = KINDS.includes(body.kind) ? body.kind : 'other';
  const source = SOURCES.includes(body.source) ? body.source : 'site';
  const os = OSES.includes(body.os) ? body.os : null;
  const version = typeof body.version === 'string' && /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,20})?$/.test(body.version)
    ? body.version : null;
  const contact = clean(body.contact, MAX_CONTACT) || null;

  const ip = request.headers.get('cf-connecting-ip') ?? '';
  if (!(await deps.limit(ip))) return json(429, { error: 'rate', detail: 'That was a lot at once. Try again in a minute.' }, cors);

  const check = typeof body.turnstile === 'string' && body.turnstile.length <= 2048
    ? await deps.verifyTurnstile(body.turnstile, ip).catch(() => null) : null;
  if (!check?.success || (check.action && check.action !== 'feedback')) {
    return json(403, { error: 'turnstile', detail: 'The check that you’re not a robot didn’t pass. Try again.' }, cors);
  }

  const now = new Date(deps.now());
  const dayAgo = new Date(deps.now() - 24 * 3600 * 1000).toISOString();
  if ((await deps.store.countSince(dayAgo)) >= DAILY_CAP) {
    return json(503, { error: 'busy', detail: 'The feedback box is full for today. Try again tomorrow.' }, cors);
  }
  await deps.store.insert({ created_at: now.toISOString(), kind, message, contact, os, version, source });
  return json(201, { ok: true }, cors);
}

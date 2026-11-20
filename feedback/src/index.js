// Perch's feedback box on Cloudflare: handler.js with a D1 database (DB), Cloudflare's rate limiter (LIMITER) and
// Turnstile, the "not a robot" check. Secrets (wrangler secret put): TURNSTILE_SECRET, ADMIN_TOKEN, DIGEST_TOKEN.
// A daily job deletes entries older than a year.
import { handle } from './handler.js';

const ALLOWED_ORIGINS = ['https://just-rice.github.io', 'https://perch-relay.justrice.workers.dev'];
const ALLOWED_HOSTS = ALLOWED_ORIGINS.map(o => new URL(o).hostname);
const KEEP_DAYS = 365;

function d1Store(db) {
  return {
    insert: (r) => db.prepare(
      'INSERT INTO feedback (created_at, kind, message, contact, os, version, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(r.created_at, r.kind, r.message, r.contact, r.os, r.version, r.source).run(),
    countSince: async (iso) => (await db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE created_at >= ?').bind(iso).first())?.n ?? 0,
    list: async ({ status, since }) => {
      const where = [], args = [];
      if (status) { where.push('status = ?'); args.push(status); }
      if (since) { where.push('created_at >= ?'); args.push(new Date(since).toISOString()); }
      const sql = `SELECT id, created_at, kind, message, contact, os, version, source, status, notes FROM feedback
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`;
      return (await db.prepare(sql).bind(...args).all()).results ?? [];
    },
    update: async (id, patch) => {
      const sets = Object.keys(patch).map(k => `${k} = ?`);
      const r = await db.prepare(`UPDATE feedback SET ${sets.join(', ')} WHERE id = ?`).bind(...Object.values(patch), id).run();
      return (r.meta?.changes ?? 0) > 0;
    },
  };
}

async function verifyTurnstile(env, token, ip) {
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET ?? '');
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = await r.json();
  // Only a check made on one of Perch's own pages counts.
  return { ...out, success: out.success === true && (!out.hostname || ALLOWED_HOSTS.includes(out.hostname)) };
}

export default {
  async fetch(request, env) {
    return handle(request, {
      allowedOrigins: ALLOWED_ORIGINS,
      verifyTurnstile: (token, ip) => verifyTurnstile(env, token, ip),
      limit: async (ip) => (env.LIMITER ? (await env.LIMITER.limit({ key: ip || 'unknown' })).success : true),
      store: d1Store(env.DB),
      digestToken: env.DIGEST_TOKEN,
      adminToken: env.ADMIN_TOKEN,
      now: () => Date.now(),
    });
  },
  async scheduled(_event, env) {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare('DELETE FROM feedback WHERE created_at < ?').bind(cutoff).run();
  },
};

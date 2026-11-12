// The relay service's book-keeping: which Macs have had relay logins, how much each has used, and the limits.
// One copy runs, inside a Durable Object (worker.js), with its own SQLite storage.
//
// The limits, all counted over the last 31 days (today and the 30 before it, UTC). Cloudflare's free 1,000 GB is per
// billing month, and a billing month can start on any day; a 31-day window that is never over the limit means no
// billing month can be either, whatever day it starts on.
//   - each Mac that isn't the owner's: macLimitGB (20)
//   - all of those Macs together: othersLimitGB (900), so strangers can never use up what the owner's Macs need
//   - everything on the Cloudflare account, the owner's Macs included: totalLimitGB (990, and never above 990)
//
// Limits are checked when a Mac asks for a login, and again every few minutes (the cron in worker.js) against fresh
// numbers from Cloudflare; logins of Macs that went over are then revoked. Logins also expire by themselves, which
// Cloudflare says ends the connection: 3 hours for other people's Macs, 24 for the owner's, and 1 hour for everyone
// once the total is within nearGB of its limit. So even a connection Cloudflare kept going after a revoke can't run on.

export const GB = 1e9; // Cloudflare counts decimal gigabytes; this errs on the safe side if it ever counts binary ones
export const HARD_TOTAL_GB = 990;

export const DEFAULT_LIMITS = Object.freeze({
  macLimitGB: 20,
  othersLimitGB: 900,
  totalLimitGB: 990,
  windowDays: 31,
  nearGB: 40,
  ttlOwnerS: 24 * 3600,
  ttlOtherS: 3 * 3600,
  ttlNearS: 3600,
  staleMs: 30 * 60e3,       // usage numbers older than this count as unknown
  refreshOnIssueMs: 2 * 60e3, // a request finding numbers older than this fetches new ones first
  perMacPerHour: 20,
  allPerHour: 3000,
});

// Limits from the Worker's settings (wrangler.toml [vars]), never looser than the hard ceiling.
export function limitsFrom(env = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== '' && v != null ? Number(v) : d);
  const total = Math.min(num(env.TOTAL_LIMIT_GB, DEFAULT_LIMITS.totalLimitGB), HARD_TOTAL_GB);
  return {
    ...DEFAULT_LIMITS,
    totalLimitGB: total,
    othersLimitGB: Math.min(num(env.OTHERS_LIMIT_GB, DEFAULT_LIMITS.othersLimitGB), total),
    macLimitGB: Math.min(num(env.MAC_LIMIT_GB, DEFAULT_LIMITS.macLimitGB), total),
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS macs (ident TEXT PRIMARY KEY, owner INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, ident TEXT NOT NULL, bytes REAL NOT NULL, PRIMARY KEY (day, ident))`,
  `CREATE TABLE IF NOT EXISTS totals (day TEXT PRIMARY KEY, bytes REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS creds (username TEXT PRIMARY KEY, ident TEXT NOT NULL, owner INTEGER NOT NULL, issued INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS creds_by_issued ON creds (issued)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
];

const day = ms => new Date(ms).toISOString().slice(0, 10);

export class LedgerCore {
  // sql: anything with exec(query, ...params) → {toArray()} (a Durable Object's ctx.storage.sql, or a test stand-in).
  constructor({ sql, turn, limits = DEFAULT_LIMITS, now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { sql, turn, limits, now, log });
    for (const s of SCHEMA) this.sql.exec(s);
  }

  _rows(q, ...p) { return this.sql.exec(q, ...p).toArray(); }
  _meta(k) { return this._rows('SELECT v FROM meta WHERE k = ?', k)[0]?.v ?? null; }
  _setMeta(k, v) { this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, v == null ? null : String(v)); }

  windowStart() { return day(this.now() - (this.limits.windowDays - 1) * 86400e3); }

  // Where things stand over the window: bytes in total, for other people's Macs together, and per Mac.
  usage() {
    const from = this.windowStart();
    const total = Number(this._rows('SELECT COALESCE(SUM(bytes), 0) AS b FROM totals WHERE day >= ?', from)[0].b);
    const per = new Map(this._rows('SELECT ident, SUM(bytes) AS b FROM usage WHERE day >= ? GROUP BY ident', from)
      .map(r => [r.ident, Number(r.b)]));
    const owners = new Set(this._rows('SELECT ident FROM macs WHERE owner = 1').map(r => r.ident));
    let others = 0;
    for (const [ident, b] of per) if (!owners.has(ident)) others += b;
    const okAt = Number(this._meta('lastOkAt') ?? 0);
    return { total, others, per, owners, okAt, fresh: okAt > 0 && this.now() - okAt < this.limits.staleMs };
  }

  // The reason a Mac may not have a login now, or null.
  _refusal(u, ident, owner) {
    const L = this.limits;
    if (!u.fresh && !(owner && u.okAt > 0 && u.total < (L.totalLimitGB - L.nearGB) * GB)) return 'unknown';
    if (u.total >= L.totalLimitGB * GB) return 'total';
    if (owner) return null;
    if (u.others >= L.othersLimitGB * GB) return 'others';
    if ((u.per.get(ident) ?? 0) >= L.macLimitGB * GB) return 'mac';
    return null;
  }

  // A Mac (already checked to be who it says, by handler.js) asks for a relay login.
  async issue({ ident, owner = false }) {
    const L = this.limits;
    const now = this.now();
    owner = !!owner;
    this.sql.exec(`INSERT INTO macs (ident, owner, first_seen, last_seen) VALUES (?, ?, ?, ?)
      ON CONFLICT (ident) DO UPDATE SET owner = excluded.owner, last_seen = excluded.last_seen`, ident, owner ? 1 : 0, now, now);

    const hourAgo = now - 3600e3;
    const mine = Number(this._rows('SELECT COUNT(*) AS n FROM creds WHERE ident = ? AND issued > ?', ident, hourAgo)[0].n);
    const all = Number(this._rows('SELECT COUNT(*) AS n FROM creds WHERE issued > ?', hourAgo)[0].n);
    if (mine >= L.perMacPerHour || all >= L.allPerHour) return this._refuse('busy', ident, owner);

    if (now - Number(this._meta('lastOkAt') ?? 0) > L.refreshOnIssueMs
        && now - Number(this._meta('lastTryAt') ?? 0) > 60e3) {
      await this.refresh();
    }
    const u = this.usage();
    const why = this._refusal(u, ident, owner);
    if (why) return this._refuse(why, ident, owner, u);

    const near = u.total >= (L.totalLimitGB - L.nearGB) * GB;
    const ttl = near ? L.ttlNearS : owner ? L.ttlOwnerS : L.ttlOtherS;
    let login;
    try {
      login = await this.turn.mint({ ttl, customIdentifier: ident });
    } catch (e) {
      this.log(`mint failed: ${e.message}`);
      return this._refuse('turn', ident, owner, u);
    }
    this.sql.exec('INSERT OR REPLACE INTO creds (username, ident, owner, issued, expires, revoked) VALUES (?, ?, ?, ?, ?, 0)',
      login.username, ident, owner ? 1 : 0, now, now + ttl * 1000);
    return { ok: true, iceServers: login.iceServers, ttl, usage: this._usageFor(u, ident, owner) };
  }

  _refuse(reason, ident, owner, u = this.usage()) {
    return { ok: false, reason, usage: this._usageFor(u, ident, owner) };
  }

  // What a Mac is told about its own use. Only the owner's Macs hear about everyone's.
  _usageFor(u, ident, owner) {
    const L = this.limits;
    return {
      macBytes: u.per.get(ident) ?? 0,
      macLimitBytes: owner ? null : L.macLimitGB * GB,
      windowDays: L.windowDays,
      ...(owner ? { owner: true, totalBytes: u.total, totalLimitBytes: L.totalLimitGB * GB,
        othersBytes: u.others, othersLimitBytes: L.othersLimitGB * GB } : {}),
    };
  }

  // Every few minutes: fresh numbers from Cloudflare, then revoke the logins of anyone over a limit.
  async refresh() {
    const now = this.now();
    this._setMeta('lastTryAt', now);
    // Yesterday and today: late numbers for yesterday still arrive just after midnight.
    const from = day(now - 86400e3), to = day(now);
    try {
      const { total, byMac } = await this.turn.usage({ from, to });
      for (const d of [from, to]) {
        this.sql.exec('DELETE FROM totals WHERE day = ?', d);
        this.sql.exec('DELETE FROM usage WHERE day = ?', d);
        if (total[d]) this.sql.exec('INSERT INTO totals (day, bytes) VALUES (?, ?)', d, total[d]);
        for (const [ident, b] of Object.entries(byMac[d] ?? {})) {
          this.sql.exec('INSERT INTO usage (day, ident, bytes) VALUES (?, ?, ?)', d, ident, b);
        }
      }
      this._setMeta('lastOkAt', now);
      this._setMeta('lastError', null);
    } catch (e) {
      this._setMeta('lastError', e.message);
      this.log(`usage refresh failed: ${e.message}`);
    }
    const revoked = await this.enforce();
    // Keep a little more than the window.
    const keepFrom = day(now - (this.limits.windowDays + 2) * 86400e3);
    this.sql.exec('DELETE FROM usage WHERE day < ?', keepFrom);
    this.sql.exec('DELETE FROM totals WHERE day < ?', keepFrom);
    this.sql.exec('DELETE FROM creds WHERE expires < ?', now - 86400e3);
    return { revoked };
  }

  // Revokes live logins that a limit no longer allows. With unknown numbers nothing is revoked (but nothing new is
  // handed out either, see _refusal), so a hiccup at Cloudflare's analytics doesn't cut off every viewer.
  async enforce() {
    const u = this.usage();
    if (!u.fresh) return 0;
    const L = this.limits;
    const live = this._rows('SELECT username, ident, owner FROM creds WHERE revoked = 0 AND expires > ?', this.now());
    let n = 0;
    for (const c of live) {
      const over = u.total >= L.totalLimitGB * GB
        || (!c.owner && (u.others >= L.othersLimitGB * GB || (u.per.get(c.ident) ?? 0) >= L.macLimitGB * GB));
      if (!over) continue;
      try {
        await this.turn.revoke(c.username);
        this.sql.exec('UPDATE creds SET revoked = 1 WHERE username = ?', c.username);
        n++;
      } catch (e) {
        this.log(`revoke failed (tried again next time): ${e.message}`);
      }
    }
    return n;
  }

  // For the owner: everything, to check the service is working.
  status() {
    const u = this.usage();
    const L = this.limits;
    const macs = this._rows('SELECT ident, owner, first_seen, last_seen FROM macs ORDER BY last_seen DESC LIMIT 200')
      .map(m => ({ ident: m.ident, owner: !!m.owner, bytes: u.per.get(m.ident) ?? 0,
        firstSeen: new Date(Number(m.first_seen)).toISOString(), lastSeen: new Date(Number(m.last_seen)).toISOString() }));
    const live = Number(this._rows('SELECT COUNT(*) AS n FROM creds WHERE revoked = 0 AND expires > ?', this.now())[0].n);
    return {
      windowFrom: this.windowStart(),
      limits: { macGB: L.macLimitGB, othersGB: L.othersLimitGB, totalGB: L.totalLimitGB, windowDays: L.windowDays },
      usedGB: { total: u.total / GB, others: u.others / GB },
      numbers: { fresh: u.fresh, readAt: u.okAt ? new Date(u.okAt).toISOString() : null, error: this._meta('lastError') },
      liveLogins: live,
      macs,
    };
  }
}

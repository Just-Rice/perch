// Cloudflare's side: making and revoking TURN logins, and reading how much has been relayed.
// API: https://developers.cloudflare.com/realtime/turn/generate-credentials/ and .../turn/analytics/
//
// Cloudflare bills for egressBytes (what its relay servers send out) across the whole account, past a free 1,000 GB a
// month. Every login this service makes carries a customIdentifier naming the Mac it was made for, so usage can be
// read back per Mac.

const RTC = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

// Two views of the same numbers for the days asked for: everything on the account by hour (what billing sees, logins
// from anywhere included), and the same split by customIdentifier.
export const USAGE_QUERY = `query PerchRelayUsage($accountTag: string!, $from: Date!, $to: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      total: callsTurnUsageAdaptiveGroups(limit: 1000, filter: { date_geq: $from, date_leq: $to }) {
        dimensions { datetimeHour }
        sum { egressBytes }
      }
      byMac: callsTurnUsageAdaptiveGroups(limit: 10000, filter: { date_geq: $from, date_leq: $to }, orderBy: [sum_egressBytes_DESC]) {
        dimensions { datetimeHour customIdentifier }
        sum { egressBytes }
      }
    }
  }
}`;

export class TurnApi {
  // rtcUrl and graphqlUrl are only ever changed by the local test (test/local-run.mjs), to a pretend Cloudflare.
  constructor({ keyId, apiToken, accountId, analyticsToken, fetchImpl = (...a) => fetch(...a), rtcUrl = RTC, graphqlUrl = GRAPHQL }) {
    Object.assign(this, { keyId, apiToken, accountId, analyticsToken, fetchImpl, rtcUrl, graphqlUrl });
  }

  get ready() { return !!(this.keyId && this.apiToken && this.accountId && this.analyticsToken); }

  // A relay login for one Mac, good for `ttl` seconds. Resolves to {username, iceServers: [{urls, username, credential}]}.
  async mint({ ttl, customIdentifier }) {
    const res = await this.fetchImpl(`${this.rtcUrl}/${encodeURIComponent(this.keyId)}/credentials/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl, customIdentifier }),
    });
    if (!res.ok) throw new Error(`Cloudflare refused to make a relay login (${res.status})`);
    const body = await res.json();
    const entries = Array.isArray(body?.iceServers) ? body.iceServers : [body?.iceServers];
    const turn = entries.find(e => e && typeof e.username === 'string' && typeof e.credential === 'string');
    if (!turn) throw new Error('Cloudflare’s answer had no relay login');
    // Relay addresses only (viewers have their own STUN servers), and never port 53, which browsers block.
    const urls = (Array.isArray(turn.urls) ? turn.urls : [turn.urls])
      .filter(u => typeof u === 'string' && /^turns?:/.test(u) && !/:53(\?|$)/.test(u));
    if (urls.length === 0) throw new Error('Cloudflare’s answer had no usable relay address');
    return { username: turn.username, iceServers: [{ urls, username: turn.username, credential: turn.credential }] };
  }

  // Ends a login early. Already gone counts as done.
  async revoke(username) {
    const res = await this.fetchImpl(
      `${this.rtcUrl}/${encodeURIComponent(this.keyId)}/credentials/${encodeURIComponent(username)}/revoke`,
      { method: 'POST', headers: { Authorization: `Bearer ${this.apiToken}` } });
    if (!res.ok && res.status !== 404) throw new Error(`Cloudflare refused to revoke a relay login (${res.status})`);
  }

  // Bytes Cloudflare's relays sent out on each day from `from` to `to` (YYYY-MM-DD, UTC): {total: {day: bytes},
  // byMac: {day: {customIdentifier: bytes}}}. Throws when the numbers can't be read, so the caller never mistakes
  // "unknown" for "nothing used".
  async usage({ from, to }) {
    const res = await this.fetchImpl(this.graphqlUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.analyticsToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: USAGE_QUERY, variables: { accountTag: this.accountId, from, to } }),
    });
    if (!res.ok) throw new Error(`Cloudflare analytics answered ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body?.errors) && body.errors.length) {
      throw new Error(`Cloudflare analytics: ${String(body.errors[0]?.message ?? 'error').slice(0, 200)}`);
    }
    const account = body?.data?.viewer?.accounts?.[0];
    if (!account || !Array.isArray(account.total) || !Array.isArray(account.byMac)) {
      throw new Error('Cloudflare analytics sent an answer without usage numbers');
    }
    const total = {}, byMac = {};
    for (const row of account.total) {
      const day = dayOf(row?.dimensions?.datetimeHour);
      if (day) total[day] = (total[day] ?? 0) + bytesOf(row);
    }
    for (const row of account.byMac) {
      const day = dayOf(row?.dimensions?.datetimeHour);
      const id = row?.dimensions?.customIdentifier;
      if (!day || typeof id !== 'string' || !id) continue;
      byMac[day] ??= {};
      byMac[day][id] = (byMac[day][id] ?? 0) + bytesOf(row);
    }
    return { total, byMac };
  }
}

const dayOf = t => (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null);
const bytesOf = row => {
  const n = Number(row?.sum?.egressBytes);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

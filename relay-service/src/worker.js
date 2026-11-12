// Perch's relay service on Cloudflare Workers: hands relay logins to Perch Macs on strict networks, within the
// limits in ledger.js. README.md says how to set it up.
import { DurableObject } from 'cloudflare:workers';
import { LedgerCore, limitsFrom } from './ledger.js';
import { TurnApi } from './turn.js';
import { handle } from './handler.js';

// The one place the numbers live: a single Durable Object, so every request sees the same counts.
export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new LedgerCore({
      sql: ctx.storage.sql,
      turn: new TurnApi({
        keyId: env.TURN_KEY_ID, apiToken: env.TURN_KEY_API_TOKEN,
        accountId: env.ACCOUNT_ID, analyticsToken: env.ANALYTICS_TOKEN,
        // Local test runs only (test/local-run.mjs); never set for the real service.
        ...(env.TEST_TURN_URL ? { rtcUrl: env.TEST_TURN_URL } : {}),
        ...(env.TEST_GRAPHQL_URL ? { graphqlUrl: env.TEST_GRAPHQL_URL } : {}),
      }),
      limits: limitsFrom(env),
      log: m => console.log(m),
    });
  }

  issue(req) { return this.core.issue(req); }
  refresh() { return this.core.refresh(); }
  status() { return this.core.status(); }
}

const ledger = env => env.LEDGER.get(env.LEDGER.idFromName('ledger'));

export default {
  fetch(request, env) {
    return handle(request, env, ledger(env)).catch(e => {
      console.log(`request failed: ${e?.stack ?? e}`);
      return new Response(JSON.stringify({ ok: false, reason: 'error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    });
  },
  // Every five minutes (wrangler.toml): fresh usage numbers, and revoke what is over a limit.
  scheduled(event, env, ctx) {
    ctx.waitUntil(ledger(env).refresh());
  },
};

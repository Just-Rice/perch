// The optional TURN relay for strict networks (school or office Wi-Fi that blocks direct connections): the owner's own
// Cloudflare TURN key, kept in the Keychain. (Without a card, the owner's own Worker relay does the same job:
// wsrelay.mjs.) The Mac sends the logins to the viewer inside the sealed offer; the viewer's browser then reaches the Mac through
// Cloudflare over the normal web port when nothing else gets through. See docs/PROTOCOL.md, "Relay".
import { cleanIceServers, hasRelay } from '../../../site/js/shared/relay.js';

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TTL_S = 24 * 3600;            // how long each set of logins lasts
// Logins are handed out until half their life is gone (so a session started on them has at least that long), and
// new ones are fetched in the background after a quarter: 12 h and 6 h for a 24-hour login.
const KEY_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;

export class Relay {
  constructor({ store, log = null, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { store, log, fetchImpl, now });
    this.cache = null;      // {list, until, refreshAt}
    this.lastError = null;
    this.lastOkAt = null;
  }

  // A relay key of the owner's own.
  get configured() { return !!this.store.relayLogin; }
  get active() { return this.configured; }

  async _mintAny() { return { list: await this.mint(), ttl: TTL_S }; }

  // Asks Cloudflare for relay logins. Throws an Error with a message fit to show the owner.
  async mint(login = this.store.relayLogin) {
    let res;
    try {
      res = await this.fetchImpl(`${API}/${encodeURIComponent(login.keyId)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${login.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_S }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new Error('Perch couldn’t reach Cloudflare. Check this Mac’s internet connection and try again.');
    }
    if ([400, 401, 403, 404].includes(res.status)) {
      throw new Error('Cloudflare didn’t accept that relay key. Check the Turn Token ID and the API token.');
    }
    if (!res.ok) throw new Error(`Cloudflare answered with an error (${res.status}). Try again in a minute.`);
    let body;
    try { body = await res.json(); } catch { throw new Error('Cloudflare sent an answer Perch couldn’t read.'); }
    const raw = Array.isArray(body?.iceServers) ? body.iceServers : [body?.iceServers];
    // Only the relay entries: viewers already have STUN servers of their own.
    const list = cleanIceServers(raw).filter(s => s.urls.some(u => !u.startsWith('stun:')));
    if (!hasRelay(list)) throw new Error('Cloudflare’s answer didn’t include a relay.');
    return list;
  }

  // Relay logins for a new connection's offer, or [] when there is no relay or Cloudflare can't be reached right now
  // (the connection then simply goes ahead without one). Logins are kept and reused; a fetch never holds an offer
  // up for more than `waitMs`, and carries on in the background so the next offer has them.
  async iceServers({ waitMs = 4000 } = {}) {
    if (!this.active) return [];
    const now = this.now();
    if (this.cache && now < this.cache.until) {
      if (now >= this.cache.refreshAt) this._refresh();
      return this.cache.list;
    }
    let timer;
    const giveUp = new Promise(resolve => { timer = setTimeout(() => resolve([]), waitMs); });
    return Promise.race([this._refresh(), giveUp]).finally(() => clearTimeout(timer));
  }

  // Fetch now so the first viewer doesn't wait (called at startup).
  warm() { if (this.active) this._refresh(); }

  // Also after Start over, which gives this Mac a new relay key.
  forget() { this.cache = null; this.lastError = null; this.lastOkAt = null; }

  _remember(list, ttlS = TTL_S) {
    const now = this.now();
    this.cache = { list, until: now + ttlS * 500, refreshAt: now + ttlS * 250 };
    this.lastOkAt = now;
    this.lastError = null;
  }

  _refresh() {
    this.refreshing ??= this._mintAny().then(({ list, ttl }) => {
      this._remember(list, ttl);
      return list;
    }, e => {
      this.lastError = e.message;
      this.log?.warn(`relay: ${e.message}`);
      return this.cache && this.now() < this.cache.until ? this.cache.list : [];
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  // Saves a relay key after checking with Cloudflare that it works. Throws with a plain message if not.
  async save(keyId, apiToken) {
    keyId = String(keyId ?? '').trim();
    apiToken = String(apiToken ?? '').trim();
    if (!KEY_ID_RE.test(keyId)) throw new Error('That Turn Token ID doesn’t look right: copy it again from Cloudflare.');
    if (!TOKEN_RE.test(apiToken)) throw new Error('That API token doesn’t look right: copy it again from Cloudflare.');
    const list = await this.mint({ keyId, apiToken });
    await this.store.setRelayLogin({ keyId, apiToken });
    this._remember(list);
  }

  async remove() {
    await this.store.setRelayLogin(null);
    this.forget();
  }

  state() {
    const working = this.configured ? (this.lastError ? false : this.lastOkAt ? true : null) : null;
    return {
      set: this.configured,
      setAt: this.store.config.relay?.setAt ?? null,
      working,
      error: this.configured ? this.lastError : null,
    };
  }
}


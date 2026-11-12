// The optional relay for strict networks (school or office Wi-Fi that blocks direct connections). Relay logins come
// from one of two places:
//   - the owner's own Cloudflare TURN key, kept in the Keychain (asked for directly), or else
//   - Perch's shared relay service (relay-service/), which hands out logins within monthly limits. This Mac proves
//     which Mac it is with its own relay key; the service owner's Macs also prove they are the owner's.
// The Mac sends the logins to the viewer inside the sealed offer; the viewer's browser then reaches the Mac through
// Cloudflare over the normal web port when nothing else gets through. See docs/PROTOCOL.md, "Relay".
import { webcrypto } from 'node:crypto';
import { cleanIceServers, hasRelay } from '../../../site/js/shared/relay.js';
import { toB64url, fromB64url, utf8 } from '../../../site/js/shared/bytes.js';
import { requestText, ownerText, REQUEST_VERSION, REFUSALS } from '../../../relay-service/src/request.js';

const subtle = webcrypto.subtle;

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TTL_S = 24 * 3600;            // how long each set of logins lasts
// Logins are handed out until half their life is gone (so a session started on them has at least that long), and
// new ones are fetched in the background after a quarter: 12 h and 6 h for a 24-hour login.
const OWNER_KEY_RE = /^[\x21-\x7e]{16,200}$/;
const KEY_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;

export class Relay {
  constructor({ store, log = null, fetchImpl = globalThis.fetch, now = () => Date.now(), serviceUrl = '' }) {
    Object.assign(this, { store, log, fetchImpl, now });
    this.serviceUrl = String(serviceUrl || '').replace(/\/+$/, '');
    this.cache = null;      // {list, until, refreshAt}
    this.lastError = null;
    this.lastOkAt = null;
    this.usage = null;      // what the shared service last said about this Mac's use
  }

  // A relay key of the owner's own.
  get configured() { return !!this.store.relayLogin; }
  // Perch's shared relay service, used when there is no key of the owner's own and the setting is on.
  get usingService() { return !this.configured && !!this.serviceUrl && this.store.settings.sharedRelay !== false; }
  get active() { return this.configured || this.usingService; }

  async _mintAny() {
    if (this.configured) return { list: await this.mint(), ttl: TTL_S };
    return this.mintService();
  }

  // This Mac's relay key, made the first time it is needed (once, even if two requests ask at the same moment).
  _identity() {
    this.identityP ??= this._loadIdentity().catch(e => { this.identityP = null; throw e; });
    return this.identityP;
  }

  async _loadIdentity() {
    const have = this.store.relayIdentity;
    if (have) {
      return { key: await subtle.importKey('pkcs8', fromB64url(have.pkcs8), { name: 'Ed25519' }, false, ['sign']), pub: have.pub };
    }
    const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const pkcs8 = toB64url(new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey)));
    const pub = toB64url(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
    await this.store.setRelayIdentity({ pkcs8, pub });
    return { key: pair.privateKey, pub };
  }

  // Asks Perch's shared relay service for logins. Throws an Error with a message fit to show the owner.
  async mintService() {
    const { key, pub } = await this._identity();
    const ts = this.now();
    let owner;
    const ownerKey = this.store.relayOwnerKey;
    if (ownerKey) {
      const k = await subtle.importKey('raw', utf8(ownerKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      owner = toB64url(new Uint8Array(await subtle.sign('HMAC', k, utf8(ownerText(pub)))));
    }
    const sig = toB64url(new Uint8Array(await subtle.sign('Ed25519', key, utf8(requestText({ mac: pub, ts, owner })))));
    let res;
    try {
      res = await this.fetchImpl(`${this.serviceUrl}/v1/ice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: REQUEST_VERSION, mac: pub, ts, sig, ...(owner ? { owner } : {}) }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new Error('Perch couldn’t reach the shared relay. Check this Mac’s internet connection.');
    }
    let body = null;
    try { body = await res.json(); } catch {}
    if (body?.usage && typeof body.usage === 'object') this.usage = cleanUsage(body.usage);
    if (!res.ok || body?.ok !== true) {
      // Logins it gave before are being revoked: stop handing them out.
      if (['mac', 'others', 'total'].includes(body?.reason)) this.cache = null;
      throw new Error(REFUSALS[body?.reason] ?? `The shared relay answered with an error (${res.status}).`);
    }
    const list = cleanIceServers(Array.isArray(body.iceServers) ? body.iceServers : [])
      .filter(s => s.urls.some(u => !u.startsWith('stun:')));
    if (!hasRelay(list)) throw new Error('The shared relay’s answer didn’t include a relay.');
    const ttl = Number.isFinite(body.ttl) && body.ttl >= 60 && body.ttl <= 172800 ? body.ttl : 3600;
    return { list, ttl };
  }

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
  forget() { this.cache = null; this.lastError = null; this.lastOkAt = null; this.usage = null; this.identityP = null; }

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

  // The owner key of the shared relay service, on its owner's own Macs: checked with the service before saving.
  async saveOwnerKey(key) {
    key = String(key ?? '').trim();
    if (!OWNER_KEY_RE.test(key)) throw new Error('That owner key doesn’t look right: copy it again.');
    if (!this.serviceUrl) throw new Error('This Perch has no shared relay service to use it with.');
    const before = this.store.relayOwnerKey;
    await this.store.setRelayOwnerKey(key);
    this.forget();
    try {
      const { list, ttl } = await this.mintService();
      if (!this.usage?.owner) throw new Error('The shared relay didn’t accept that owner key.');
      if (!this.configured) this._remember(list, ttl);
    } catch (e) {
      await this.store.setRelayOwnerKey(before);
      this.forget();
      throw e;
    }
  }

  async removeOwnerKey() {
    await this.store.setRelayOwnerKey(null);
    this.forget();
  }

  state() {
    const working = this.active ? (this.lastError ? false : this.lastOkAt ? true : null) : null;
    return {
      set: this.configured,
      setAt: this.store.config.relay?.setAt ?? null,
      working: this.configured ? working : null,
      error: this.configured ? this.lastError : null,
      shared: {
        available: !!this.serviceUrl,
        on: this.store.settings.sharedRelay !== false,
        using: this.usingService,
        owner: !!this.store.relayOwnerKey,
        working: this.usingService ? working : null,
        error: this.usingService ? this.lastError : null,
        usage: this.usage,
      },
    };
  }
}

// Only numbers, as the service sends them.
function cleanUsage(u) {
  const n = v => (Number.isFinite(v) && v >= 0 ? v : null);
  return {
    macBytes: n(u.macBytes) ?? 0, macLimitBytes: n(u.macLimitBytes), windowDays: n(u.windowDays) ?? 31, owner: u.owner === true,
    ...(u.owner === true ? { totalBytes: n(u.totalBytes), totalLimitBytes: n(u.totalLimitBytes),
      othersBytes: n(u.othersBytes), othersLimitBytes: n(u.othersLimitBytes) } : {}),
  };
}

// The Mac's side of rendezvous: answering viewers' hellos with a WebRTC offer (or a refusal) and taking their
// answers. See docs/PROTOCOL.md, "Rendezvous".
//
// The host topic (key from sigKey) is always listened to; the name topic (key from the Mac name) only while backup
// sign-in is on. Anyone can publish to a public broker, and the name key is guessable, so nothing here is trusted:
// hellos are rate limited, at most a few sign-ins may be in progress, and the real checks happen later, over the
// WebRTC connection itself (src/session.mjs).
import {
  hostTopic, nameTopic, replyTopic, hostEnvelopeKey, nameEnvelopeKey,
} from '../../../site/js/shared/rendezvous.js';
import { PROTO, MIN_PEER_PROTO } from '../../../site/js/shared/proto.js';

export const HELLOS_PER_MINUTE = 20;
export const MAX_UNAUTHENTICATED = 3;
export const MAX_SDP_BYTES = 32 * 1024;
const ID16_RE = /^[A-Za-z0-9_-]{22}$/;   // 16 random bytes in base64url
const MAX_OFFER_RESENDS = 3;
const FORGET_AFTER_MS = 5 * 60 * 1000;

export class Signaling {
  // hub: { hv, refusal(hello, kind) → null | {reason, retryAfter?}, unauthenticatedCount(kind), createSession(hello, kind) }
  constructor({ rendezvous, hub, log = null, now = () => Date.now() }) {
    this.rv = rendezvous;
    this.hub = hub;
    this.log = log;
    this.now = now;
    this.host = null;      // {topic, key}
    this.name = null;      // {topic, key, macName}
    this.recentByKind = {}; // kind ('host' | 'name') -> times of accepted hellos, for the per-minute limit
    this.lastRateReply = {}; // kind -> when we last answered 'rate'
    this.sids = new Map(); // sid -> {kind, topic, key, session?, offer?, resends, at}
    this.stats = { hellos: 0, offers: 0, refusals: {}, dropped: 0, answers: 0 };
  }

  // (Re)listen on the host topic for this hostId/sigKey (they change after a reset).
  async setHost(hostId, sigKey) {
    const topic = await hostTopic(hostId);
    if (this.host?.topic === topic) return;
    if (this.host) await this.rv.unlisten(this.host.topic);
    const key = await hostEnvelopeKey(sigKey);
    this.host = { topic, key };
    await this.rv.listen(topic, key, (msg, info) => this._receive('host', msg, info));
  }

  // Listen on the name topic while backup sign-in is on (macName), or stop (null).
  async setName(macName) {
    const topic = macName ? await nameTopic(macName) : null;
    if (this.name?.topic === topic) return;
    if (this.name) {
      const old = this.name.topic;
      this.name = null;
      await this.rv.unlisten(old);
    }
    if (!topic) return;
    const key = await nameEnvelopeKey(macName);
    this.name = { topic, key, macName };
    await this.rv.listen(topic, key, (msg, info) => this._receive('name', msg, info));
  }

  get listening() {
    return { host: this.host?.topic ?? null, name: this.name?.topic ?? null };
  }

  async close() {
    if (this.host) await this.rv.unlisten(this.host.topic).catch(() => {});
    if (this.name) await this.rv.unlisten(this.name.topic).catch(() => {});
    this.host = this.name = null;
  }

  // --- internals ---

  _drop(why) {
    this.stats.dropped++;
    this.log?.debug(`rendezvous: dropped (${why})`);
  }

  async _receive(kind, msg, { topic }) {
    const where = kind === 'host' ? this.host : this.name;
    if (!where || where.topic !== topic) return;
    this._forget();
    if (msg.t === 'hello') return this._hello(kind, where, msg);
    if (msg.t === 'answer') return this._answer(kind, where, msg);
    // Our own offers and refusals go to reply topics, which we don't listen to; anything else is noise.
  }

  _reply(where, sid, obj) {
    return this.rv.send(replyTopic(where.topic, sid), where.key, { sid, ...obj }).catch(e => {
      this.log?.warn(`rendezvous: could not reply: ${e.message}`);
    });
  }

  _refuse(where, sid, reason, retryAfter) {
    this.stats.refusals[reason] = (this.stats.refusals[reason] ?? 0) + 1;
    this.log?.info(`rendezvous: refused a ${where === this.name ? 'backup' : 'host'} hello (${reason})`);
    return this._reply(where, sid, {
      t: 'refuse', reason, ...(retryAfter ? { retryAfter } : {}), pv: PROTO, minPv: MIN_PEER_PROTO, hv: this.hub.hv,
    });
  }

  async _hello(kind, where, msg) {
    const { sid, pv, route } = msg;
    if (typeof sid !== 'string' || !ID16_RE.test(sid)) return this._drop('bad sid');
    if (!Number.isInteger(pv) || pv < 0) return this._drop('bad pv');
    const routes = kind === 'host' ? ['passkey', 'pair'] : ['backup'];
    if (!routes.includes(route)) return this._drop(`route ${route} on the ${kind} topic`);
    if (route === 'pair' && (typeof msg.pairId !== 'string' || !ID16_RE.test(msg.pairId))) return this._drop('bad pairId');

    // The same hello again (a viewer retrying, or one copy per broker after a reconnect): resend the offer.
    const known = this.sids.get(sid);
    if (known) {
      if (known.offer && known.session?.state === 'offered' && known.resends < MAX_OFFER_RESENDS && known.topic === where.topic) {
        known.resends++;
        await this._reply(where, sid, known.offer);
      } else this._drop('duplicate hello');
      return;
    }
    const t = this.now();
    // Each topic has its own budget: the name topic only needs the Mac's name, so a stranger flooding it must not use
    // up what the owner's passkey devices (host topic, which needs the rendezvous key) rely on.
    const recent = (this.recentByKind[kind] ??= []).filter(x => t - x < 60000);
    this.recentByKind[kind] = recent;
    if (recent.length >= HELLOS_PER_MINUTE) {
      // Answer at most once a second, so a flood of hellos can't make us flood the brokers in turn.
      if (t - (this.lastRateReply[kind] ?? 0) < 1000) return this._drop('rate');
      this.lastRateReply[kind] = t;
      return this._refuse(where, sid, 'rate', Math.max(1, Math.ceil((recent[0] + 60000 - t) / 1000)));
    }
    recent.push(t);
    this.stats.hellos++;
    const entry = { kind, topic: where.topic, key: where.key, session: null, offer: null, resends: 0, at: t };
    this.sids.set(sid, entry);

    if (pv < MIN_PEER_PROTO) return this._refuse(where, sid, 'version');
    const label = typeof msg.label === 'string' ? msg.label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : '';
    const hello = { sid, pv, route, label: label || 'a browser', pairId: route === 'pair' ? msg.pairId : undefined };
    const no = this.hub.refusal(hello, kind);
    if (no) return this._refuse(where, sid, no.reason, no.retryAfter);
    if (this.hub.unauthenticatedCount(kind) >= MAX_UNAUTHENTICATED) return this._refuse(where, sid, 'busy', 10);

    let session, sdp;
    try {
      session = this.hub.createSession(hello, kind);
      entry.session = session;
      sdp = await session.offer();
    } catch (e) {
      this.log?.error('could not make an offer:', e);
      session?.end('error', { sendBye: false });
      return this._refuse(where, sid, 'busy', 5);
    }
    if (session.state !== 'offered') return; // ended while gathering (paused, timed out...)
    // The owner's relay, if any, for viewers on networks that block direct connections (see relay.mjs).
    const iceServers = this.hub.relayIceServers ? await this.hub.relayIceServers() : [];
    if (session.state !== 'offered') return;
    // caps: what this Mac can do beyond protocol 1 ("quick" = one-tap passkey sign-in, see bind.js).
    entry.offer = { t: 'offer', pv: PROTO, minPv: MIN_PEER_PROTO, hv: this.hub.hv, sdp, ...(this.hub.caps?.length ? { caps: this.hub.caps } : {}),
      ...(iceServers.length ? { iceServers } : {}) };
    this.stats.offers++;
    await this._reply(where, sid, entry.offer);
  }

  async _answer(kind, where, msg) {
    const entry = typeof msg.sid === 'string' ? this.sids.get(msg.sid) : null;
    if (!entry || !entry.session || entry.topic !== where.topic) return this._drop('answer for an unknown session');
    if (typeof msg.sdp !== 'string' || msg.sdp.length > MAX_SDP_BYTES || !msg.sdp.startsWith('v=0')) return this._drop('bad answer');
    if (entry.session.state !== 'offered') return this._drop('second answer');
    this.stats.answers++;
    try {
      await entry.session.answer(msg.sdp);
    } catch (e) {
      this.log?.warn(`answer rejected: ${e.message}`);
      entry.session.end('disconnected', { sendBye: false });
    }
  }

  // Sessions that ended, and hellos long gone, needn't be remembered.
  _forget() {
    const t = this.now();
    for (const [sid, e] of this.sids) {
      if (t - e.at > FORGET_AFTER_MS && (!e.session || e.session.state === 'ended')) this.sids.delete(sid);
    }
  }
}

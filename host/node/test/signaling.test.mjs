// The Mac's side of rendezvous, with a fake broker client and a fake hub: which hellos get an offer, which get a
// refusal and which are dropped without a word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Signaling, HELLOS_PER_MINUTE, MAX_UNAUTHENTICATED, MAX_SDP_BYTES } from '../src/signaling.mjs';
import { hostTopic, nameTopic, replyTopic } from '../../../site/js/shared/rendezvous.js';
import { toB64url, randomBytes } from '../../../site/js/shared/bytes.js';
import { PROTO, MIN_PEER_PROTO } from '../../../site/js/shared/proto.js';

const sid = () => toB64url(randomBytes(16));

class FakeRendezvous {
  constructor() { this.handlers = new Map(); this.sent = []; this.unlistened = []; }
  async listen(topic, key, handler) { this.handlers.set(topic, handler); }
  async unlisten(topic) { this.handlers.delete(topic); this.unlistened.push(topic); }
  async send(topic, key, obj) { this.sent.push({ topic, obj }); return 1; }
  // A message arriving on `topic`, as Rendezvous would hand it over after opening the envelope.
  deliver(topic, msg) { return this.handlers.get(topic)?.(msg, { topic, broker: 'test' }); }
}

class FakeSession {
  constructor(hello) { this.hello = hello; this.state = 'new'; this.answers = []; this.ended = null; }
  async offer() { this.state = 'offered'; return 'v=0\r\nfake offer\r\n'; }
  async answer(sdp) { this.answers.push(sdp); this.state = 'connecting'; }
  end(reason) { this.state = 'ended'; this.ended = reason; }
}

async function setup({ refusal = () => null } = {}) {
  let t = 1_000_000;
  const sessions = [];
  const hub = {
    hv: '9.9.9',
    refusal,
    unauthenticatedCount: () => sessions.filter(s => s.state !== 'ended' && s.state !== 'ready').length,
    createSession: (hello, kind) => { const s = new FakeSession({ ...hello, kind }); sessions.push(s); return s; },
  };
  const rv = new FakeRendezvous();
  const sig = new Signaling({ rendezvous: rv, hub, now: () => t });
  const hostId = randomBytes(16), sigKey = randomBytes(32);
  await sig.setHost(hostId, sigKey);
  const topic = await hostTopic(hostId);
  return { sig, rv, hub, sessions, topic, hostId, sigKey, tick: ms => { t += ms; } };
}

const hello = (extra = {}) => ({ t: 'hello', sid: sid(), pv: PROTO, route: 'passkey', label: 'Safari on iPhone', ...extra });
const repliesTo = (rv, topic, s) => rv.sent.filter(x => x.topic === replyTopic(topic, s)).map(x => x.obj);

test('a good hello gets a complete offer on its reply topic', async () => {
  const { rv, sessions, topic } = await setup();
  const h = hello();
  await rv.deliver(topic, h);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].hello.label, 'Safari on iPhone');
  assert.equal(sessions[0].hello.kind, 'host');
  assert.deepEqual(repliesTo(rv, topic, h.sid), [{ sid: h.sid, t: 'offer', pv: PROTO, minPv: MIN_PEER_PROTO, hv: '9.9.9', sdp: 'v=0\r\nfake offer\r\n' }]);
  // The answer reaches the session exactly as it was sent.
  await rv.deliver(topic, { t: 'answer', sid: h.sid, sdp: 'v=0\r\nanswer\r\n' });
  assert.deepEqual(sessions[0].answers, ['v=0\r\nanswer\r\n']);
  // A second answer, an answer for nobody, junk and an oversized one are dropped.
  await rv.deliver(topic, { t: 'answer', sid: h.sid, sdp: 'v=0\r\nagain' });
  await rv.deliver(topic, { t: 'answer', sid: sid(), sdp: 'v=0\r\n' });
  await rv.deliver(topic, { t: 'answer', sid: h.sid, sdp: 42 });
  assert.deepEqual(sessions[0].answers, ['v=0\r\nanswer\r\n']);
  const h2 = hello();
  await rv.deliver(topic, h2);
  await rv.deliver(topic, { t: 'answer', sid: h2.sid, sdp: 'v=0' + 'x'.repeat(MAX_SDP_BYTES) });
  await rv.deliver(topic, { t: 'answer', sid: h2.sid, sdp: 'not an sdp' });
  assert.deepEqual(sessions[1].answers, []);
});

test('labels are cleaned and missing ones get a default', async () => {
  const { rv, sessions, topic } = await setup();
  await rv.deliver(topic, hello({ label: '  Chrome\u0000 on\u001b Mac ' + 'x'.repeat(100) }));
  assert.equal(sessions[0].hello.label.length, 64);
  assert.ok(!/[\u0000-\u001f]/.test(sessions[0].hello.label));
  await rv.deliver(topic, hello({ label: undefined }));
  assert.equal(sessions[1].hello.label, 'a browser');
});

test('malformed hellos and wrong routes for the topic are dropped silently', async () => {
  const { rv, sig, sessions, topic } = await setup();
  for (const bad of [
    hello({ sid: 'short' }), hello({ sid: 42 }), hello({ pv: '1' }), hello({ pv: -1 }), hello({ route: 'backup' }),
    hello({ route: 'admin' }), hello({ route: 'pair' }), hello({ route: 'pair', pairId: 'nope' }),
  ]) await rv.deliver(topic, bad);
  assert.equal(sessions.length, 0);
  assert.equal(rv.sent.length, 0, 'not even a refusal');
  assert.equal(sig.stats.dropped, 8);
  // Pairing needs a proper pair id.
  await rv.deliver(topic, hello({ route: 'pair', pairId: toB64url(randomBytes(16)) }));
  assert.equal(sessions.length, 1);
  assert.equal(typeof sessions[0].hello.pairId, 'string');
});

test('old viewers are told to reload, and the hub can refuse', async () => {
  const { rv, sessions, topic } = await setup({ refusal: h => (h.label === 'locked' ? { reason: 'locked-out', retryAfter: 42 } : null) });
  const old = hello({ pv: MIN_PEER_PROTO - 1 });
  await rv.deliver(topic, old);
  assert.deepEqual(repliesTo(rv, topic, old.sid), [{ sid: old.sid, t: 'refuse', reason: 'version', pv: PROTO, minPv: MIN_PEER_PROTO, hv: '9.9.9' }]);
  const l = hello({ label: 'locked' });
  await rv.deliver(topic, l);
  assert.equal(repliesTo(rv, topic, l.sid)[0].reason, 'locked-out');
  assert.equal(repliesTo(rv, topic, l.sid)[0].retryAfter, 42);
  assert.equal(sessions.length, 0);
});

test(`at most ${MAX_UNAUTHENTICATED} sign-ins at once; the next is told the Mac is busy`, async () => {
  const { rv, sessions, topic } = await setup();
  for (let i = 0; i < MAX_UNAUTHENTICATED; i++) await rv.deliver(topic, hello());
  const extra = hello();
  await rv.deliver(topic, extra);
  assert.equal(sessions.length, MAX_UNAUTHENTICATED);
  assert.equal(repliesTo(rv, topic, extra.sid)[0].reason, 'busy');
  sessions[0].end('denied');
  await rv.deliver(topic, hello());
  assert.equal(sessions.length, MAX_UNAUTHENTICATED + 1, 'room again once one has finished');
});

test('the same hello again gets the same offer (a few times), never a second session', async () => {
  const { rv, sessions, topic } = await setup();
  const h = hello();
  for (let i = 0; i < 6; i++) await rv.deliver(topic, h);
  assert.equal(sessions.length, 1);
  const offers = repliesTo(rv, topic, h.sid);
  assert.equal(offers.length, 4, 'the offer, then up to three resends');
  assert.ok(offers.every(o => o.sdp === offers[0].sdp));
});

test(`${HELLOS_PER_MINUTE} hellos a minute; refusals for more are themselves limited`, async () => {
  const { rv, sessions, topic, tick } = await setup();
  for (let i = 0; i < HELLOS_PER_MINUTE; i++) {
    await rv.deliver(topic, hello());
    sessions.at(-1).end('denied'); // keep room under the in-progress limit
    tick(100);
  }
  const over = hello();
  await rv.deliver(topic, over);
  const r = repliesTo(rv, topic, over.sid);
  assert.equal(r[0].reason, 'rate');
  assert.ok(r[0].retryAfter >= 1 && r[0].retryAfter <= 60);
  const flood = hello();
  await rv.deliver(topic, flood);
  assert.equal(repliesTo(rv, topic, flood.sid).length, 0, 'a second refusal within a second is not sent');
  tick(61_000);
  await rv.deliver(topic, hello());
  assert.equal(sessions.length, HELLOS_PER_MINUTE + 1, 'a minute later hellos are welcome again');
});

test('the name topic is only listened to while backup sign-in is on, and only takes backup hellos', async () => {
  const { rv, sig, sessions, topic, hostId, sigKey } = await setup();
  const nt = await nameTopic('amber-otter-4821');
  assert.equal(rv.handlers.has(nt), false);
  await sig.setName('Amber-Otter-4821');
  assert.equal(rv.handlers.has(nt), true, 'the name is normalized');
  assert.deepEqual(sig.listening, { host: topic, name: nt });
  await rv.deliver(nt, hello({ route: 'passkey' }));
  assert.equal(sessions.length, 0, 'passkeys never sign in through the name topic');
  const b = hello({ route: 'backup' });
  await rv.deliver(nt, b);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].hello.kind, 'name');
  assert.equal(repliesTo(rv, nt, b.sid)[0].t, 'offer');
  // An answer must come back on the topic its hello used.
  await rv.deliver(topic, { t: 'answer', sid: b.sid, sdp: 'v=0\r\n' });
  assert.deepEqual(sessions[0].answers, []);
  await rv.deliver(nt, { t: 'answer', sid: b.sid, sdp: 'v=0\r\n' });
  assert.deepEqual(sessions[0].answers, ['v=0\r\n']);
  await sig.setName(null);
  assert.equal(rv.handlers.has(nt), false);
  assert.deepEqual(rv.unlistened, [nt]);
  // A new identity (after a reset) moves the host topic.
  await sig.setHost(hostId, sigKey);
  assert.equal(rv.unlistened.length, 1, 'same identity: nothing changes');
  await sig.setHost(randomBytes(16), randomBytes(32));
  assert.deepEqual(rv.unlistened, [nt, topic]);
  await sig.close();
});

test('a session that fails to make an offer is ended and the viewer told to try again', async () => {
  const { rv, sig, topic } = await setup();
  sig.hub.createSession = hello => {
    const s = new FakeSession(hello);
    s.offer = async () => { throw new Error('no network'); };
    sig.lastSession = s;
    return s;
  };
  const h = hello();
  await rv.deliver(topic, h);
  assert.equal(sig.lastSession.state, 'ended');
  assert.equal(repliesTo(rv, topic, h.sid)[0].reason, 'busy');
});

// A bare-bones viewer for the host's headless-Chrome smoke test: it pairs from a `#pair=` link exactly as the
// protocol says (rendezvous, a real browser WebRTC answer, binding, a real WebAuthn passkey made by CDP's virtual
// authenticator, then the code), and shows the Mac's picture. Everything the test needs to check is in
// window.__perch. It uses only the shared modules, so it depends on nothing the website team is building.
import { Rendezvous, hostTopic, hostEnvelopeKey, replyTopic } from '/shared/rendezvous.js';
import { bindingHash, bindProof } from '/shared/bind.js';
import { toB64url, fromB64url, randomBytes } from '/shared/bytes.js';
import { PROTO, HOST_ID_BYTES, SIG_KEY_BYTES, PAIR_ID_BYTES, PAIR_SECRET_BYTES } from '/shared/proto.js';

const state = window.__perch = { step: 'starting', error: null, log: [], messages: [], channels: {}, stats: null, beforeCode: null };
const logEl = document.getElementById('log');
const log = (...parts) => {
  const line = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  state.log.push(line);
  logEl.textContent += line + '\n';
};

let giveCode;
const codeGiven = new Promise(resolve => { giveCode = resolve; });
window.__code = code => giveCode(code);

const channels = {};
window.__send = (label, obj) => channels[label].send(JSON.stringify(obj));

// Control messages, in order, with a way to wait for the next one of some types.
const inbox = [];
const waiting = [];
function deliver(msg) {
  state.messages.push(msg.t);
  const i = waiting.findIndex(w => w.types.includes(msg.t));
  if (i >= 0) waiting.splice(i, 1)[0].resolve(msg); else inbox.push(msg);
}
function next(...types) {
  const i = inbox.findIndex(m => types.includes(m.t));
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise(resolve => waiting.push({ types, resolve }));
}

async function stats(pc) {
  const out = { video: null, audio: null };
  (await pc.getStats()).forEach(s => {
    if (s.type !== 'inbound-rtp') return;
    const pick = ({ packetsReceived = 0, bytesReceived = 0, framesDecoded, keyFramesDecoded, frameWidth, frameHeight, audioLevel, totalSamplesReceived }) =>
      ({ packetsReceived, bytesReceived, framesDecoded, keyFramesDecoded, frameWidth, frameHeight, audioLevel, totalSamplesReceived });
    out[s.kind] = pick(s);
  });
  return out;
}

async function main() {
  const brokers = new URLSearchParams(location.search).get('brokers').split(',');
  const token = fromB64url(location.hash.replace(/^#pair=/, ''));
  let o = 0;
  const take = n => token.slice(o, (o += n));
  const hostId = take(HOST_ID_BYTES), sigKey = take(SIG_KEY_BYTES), pairId = take(PAIR_ID_BYTES), pairSecret = take(PAIR_SECRET_BYTES);

  const topic = await hostTopic(hostId);
  const key = await hostEnvelopeKey(sigKey);
  const rv = new Rendezvous({ brokers });
  await rv.start(5000);
  const sid = toB64url(randomBytes(16));
  let gotReply;
  const reply = new Promise(resolve => { gotReply = resolve; });
  // Subscribed (the broker has acknowledged) before saying hello, so the answer can't be missed.
  await rv.listen(replyTopic(topic, sid), key, m => { if (m.sid === sid) gotReply(m); });
  await rv.send(topic, key, { t: 'hello', sid, pv: PROTO, route: 'pair', label: 'Headless Chrome', pairId: toB64url(pairId) });
  const offer = await reply;
  if (offer.t !== 'offer') throw new Error(`refused: ${offer.reason}`);
  state.step = 'offer';

  const pc = new RTCPeerConnection({ iceServers: [] });
  window.__pc = pc;
  const video = document.getElementById('video');
  const stream = new MediaStream();
  pc.ontrack = e => { stream.addTrack(e.track); video.srcObject = stream; video.play().catch(() => {}); };
  const control = new Promise(resolve => {
    pc.ondatachannel = ({ channel }) => {
      channels[channel.label] = channel;
      state.channels[channel.label] = { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits };
      if (channel.label === 'control') {
        channel.onmessage = e => deliver(JSON.parse(e.data));
        resolve(channel);
      }
    };
  });
  await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); };
    setTimeout(resolve, 3000);
  });
  const answerSdp = pc.localDescription.sdp;
  await rv.send(topic, key, { t: 'answer', sid, sdp: answerSdp });
  const ch = await control;
  const send = obj => ch.send(JSON.stringify(obj));

  const hi = await next('hi');
  rv.close();
  state.step = 'hi';
  const bind = await bindingHash(fromB64url(hi.nonce), offer.sdp, answerSdp);
  send({ t: 'pair1', pairId: toB64url(pairId), proof: toB64url(await bindProof(pairSecret, 'pair', bind)) });
  const opts = await next('pair-options', 'denied');
  if (opts.t === 'denied') throw new Error(`denied: ${opts.reason}`);
  state.step = 'creating';
  const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts.options) });
  send({ t: 'pair-cred', response: cred.toJSON(), label: 'Headless Chrome' });
  const ask = await next('totp', 'denied');
  if (ask.t === 'denied') throw new Error(`denied: ${ask.reason}`);

  // Everything but the code has passed. Give media a moment to leak, if it would, before the test types the code.
  await new Promise(r => setTimeout(r, 700));
  state.beforeCode = await stats(pc);
  state.step = 'code';
  send({ t: 'code', code: await codeGiven });
  const paired = await next('paired', 'denied');
  if (paired.t === 'denied') throw new Error(`denied: ${paired.reason}`);
  state.paired = paired;
  state.ready = await next('ready', 'denied');
  if (state.ready.t !== 'ready') throw new Error(`denied: ${state.ready.reason}`);
  state.step = 'ready';
  log('signed in');

  state.presented = 0;
  const onFrame = (_, meta) => { state.presented++; state.lastFrame = { width: meta.width, height: meta.height }; video.requestVideoFrameCallback(onFrame); };
  video.requestVideoFrameCallback(onFrame);
  setInterval(async () => { state.stats = await stats(pc); }, 250);
}

main().catch(e => { state.error = String(e?.stack ?? e); log('error:', state.error); });

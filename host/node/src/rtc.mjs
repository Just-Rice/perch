// The Mac's side of each WebRTC connection, built on werift. See docs/PROTOCOL.md, "WebRTC".
//
// The Mac is always the offerer: one sendonly H.264 video track (nothing else is offered, so the browser can't pick
// a codec the Mac can't make), one sendonly Opus track, and the three data channels. ICE is not trickled: the offer
// is sent once gathering has finished, so a single rendezvous message carries everything. The exact offer and
// answer texts are kept because the sign-in proofs are bound to them (site/js/shared/bind.js).
import { RTCPeerConnection, RTCSctpTransport, Connection, useH264, useOPUS, useNACK, usePLI, useREMB, useSdesMid, useAbsSendTime } from 'werift';
import { CONTROL_CHANNEL, INPUT_CHANNEL, POINTER_CHANNEL } from '../../../site/js/shared/proto.js';

export const VIDEO_FMTP = 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1';
// stereo/sprop-stereo make browsers decode both channels instead of folding the Mac's sound down to mono.
export const OPUS_FMTP = 'minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1';
export const GATHER_TIMEOUT_MS = 5000;

// Two fixes for werift 0.25.0, applied once, before any peer is made:
//
// 1. werift quietly uses stun.l.google.com when no STUN server is configured, so "no STUN" would still contact
//    Google. This makes an empty list really mean host candidates only. Found in the spike.
// 2. When werift announces a data channel to the browser (RFC 8832 DATA_CHANNEL_OPEN), a channel that is both
//    unordered and limited in retransmits loses its "unordered" flag, so the browser would deliver `pointer` moves
//    in order and a late one would hold up the next. This sends the flag the RFC asks for (0x80 | type).
export function applyWeriftPatches() {
  const ice = Connection.prototype;
  if (!ice.__perchNoDefaultStun) {
    const orig = ice.applyStunTurnServersFromOptions;
    if (typeof orig !== 'function') throw new Error('werift changed: applyStunTurnServersFromOptions is missing');
    ice.applyStunTurnServersFromOptions = function () {
      orig.call(this);
      if (!this.options.stunServer) this.stunServer = undefined;
    };
    ice.__perchNoDefaultStun = true;
  }
  const sctp = RTCSctpTransport.prototype;
  if (sctp.__perchUnorderedFlag === undefined) {
    // Only replace the exact code this was written against; a newer werift may well have fixed it. (This reads
    // werift's source text, so the bundle must not be minified.)
    const matches = /channelType = 128;[\s\S]*channelType = 1;/.test(String(sctp.dataChannelOpen));
    if (matches) sctp.dataChannelOpen = dataChannelOpenFixed;
    sctp.__perchUnorderedFlag = matches;
  }
  return { noDefaultStun: true, unorderedFlag: sctp.__perchUnorderedFlag };
}

const DATA_CHANNEL_OPEN = 3;
const WEBRTC_DCEP = 50;

// werift's RTCSctpTransport.dataChannelOpen with the channel type worked out as RFC 8832 section 5.1 says.
function dataChannelOpenFixed(channel) {
  if (channel.id !== undefined) {
    if (this.dataChannels[channel.id]) throw new Error(`Data channel with ID ${channel.id} already registered`);
    this.dataChannels[channel.id] = channel;
  }
  let channelType = channel.ordered ? 0x00 : 0x80;
  let reliability = 0;
  if (channel.maxRetransmits !== null) {
    channelType |= 0x01;
    reliability = channel.maxRetransmits;
  } else if (channel.maxPacketLifeTime !== null) {
    channelType |= 0x02;
    reliability = channel.maxPacketLifeTime;
  }
  const label = Buffer.from(channel.label, 'utf8');
  const protocol = Buffer.from(channel.protocol, 'utf8');
  const head = Buffer.alloc(12);
  head.writeUInt8(DATA_CHANNEL_OPEN, 0);
  head.writeUInt8(channelType, 1);
  head.writeUInt16BE(0, 2); // priority
  head.writeUInt32BE(reliability, 4);
  head.writeUInt16BE(label.length, 8);
  head.writeUInt16BE(protocol.length, 10);
  this.dataChannelQueue.push([channel, WEBRTC_DCEP, Buffer.concat([head, label, protocol])]);
  this.dataChannelFlush();
}

export function peerConfig({ iceServers = [], iceLoopback = false } = {}) {
  return {
    iceServers: iceServers.map(s => ({ ...s })),
    codecs: {
      video: [useH264({ rtcpFeedback: [useNACK(), usePLI(), useREMB()], parameters: VIDEO_FMTP })],
      audio: [useOPUS({ parameters: OPUS_FMTP })],
    },
    // abs-send-time lets the browser's bandwidth estimator (the source of REMB) measure delay changes.
    headerExtensions: { video: [useSdesMid(), useAbsSendTime()], audio: [useSdesMid()] },
    bundlePolicy: 'max-bundle',
    iceStunGatherTimeout: 3,
    // Test mode without STUN: also offer a loopback candidate so two processes on one Mac always find each other.
    ...(iceLoopback ? { iceAdditionalHostAddresses: ['127.0.0.1'], iceUseIpv6: false } : {}),
  };
}

function waitForGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { sub.unSubscribe(); resolve(false); }, timeoutMs);
    const sub = pc.iceGatheringStateChange.subscribe(state => {
      if (state === 'complete') { clearTimeout(timer); sub.unSubscribe(); resolve(true); }
    });
  });
}

export class HostPeer {
  constructor({ iceServers = [], iceLoopback = false, log = null } = {}) {
    applyWeriftPatches();
    this.log = log;
    this.pc = new RTCPeerConnection(peerConfig({ iceServers, iceLoopback }));
    this.videoTransceiver = this.pc.addTransceiver('video', { direction: 'sendonly' });
    this.audioTransceiver = this.pc.addTransceiver('audio', { direction: 'sendonly' });
    this.channels = {
      control: this.pc.createDataChannel(CONTROL_CHANNEL, { ordered: true }),
      input: this.pc.createDataChannel(INPUT_CHANNEL, { ordered: true }),
      // Pointer moves only: a late move is worthless, so never retransmit and never hold others up.
      pointer: this.pc.createDataChannel(POINTER_CHANNEL, { ordered: false, maxRetransmits: 0 }),
    };
    this.offerSdp = null;
    this.answerSdp = null;
    this.closed = false;
  }

  get videoSender() { return this.videoTransceiver.sender; }
  get audioSender() { return this.audioTransceiver.sender; }
  get connectionState() { return this.pc.connectionState; }

  // Resolves to the complete offer text, exactly as it must be sent.
  async createOffer({ timeoutMs = GATHER_TIMEOUT_MS } = {}) {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    const complete = await waitForGathering(this.pc, timeoutMs);
    if (!complete) this.log?.warn('ICE gathering did not finish in time; sending the candidates found so far');
    this.offerSdp = this.pc.localDescription.sdp;
    return this.offerSdp;
  }

  // `sdp` must be the answer text exactly as it arrived; it is part of the binding.
  async acceptAnswer(sdp) {
    if (this.answerSdp !== null) throw new Error('answer already set');
    this.answerSdp = sdp;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  onConnectionState(fn) {
    const sub = this.pc.connectionStateChange.subscribe(fn);
    return () => sub.unSubscribe();
  }

  // Fingerprints and state of the DTLS transport, for logs and tests. The binding itself uses the SDP texts, which
  // carry these same fingerprints; werift fails the connection if the certificate doesn't match the answer's.
  dtlsInfo() {
    const t = this.pc.dtlsTransports?.[0];
    if (!t) return null;
    const fp = list => (list ?? []).map(f => `${f.algorithm} ${f.value}`);
    return {
      state: t.state,
      role: t.role,
      local: fp(t.localParameters?.fingerprints),
      remote: fp(t.remoteParameters?.fingerprints),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.pc.close(); } catch {}
  }
}

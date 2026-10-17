// The Mac's WebRTC peer: what its offer says, and a real connection to a werift "browser" on this Mac (loopback
// only, no STUN). A changed DTLS fingerprint must stop the connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RTCSctpTransport } from 'werift';
import { HostPeer, peerConfig, applyWeriftPatches, VIDEO_FMTP } from '../src/rtc.mjs';
import { connect, waitConnected } from './rtc-helpers.mjs';
import { ICE_SERVERS } from '../../../site/js/shared/proto.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lines = (sdp, re) => sdp.split(/\r?\n/).filter(l => re.test(l));
const section = (sdp, kind) => sdp.split(/\r?\nm=/).find(s => s.startsWith(kind)) ?? '';

test('the offer: H.264 only with nack, pli and REMB; Opus; sendonly; one data section; host candidates only', async () => {
  const peer = new HostPeer({ iceServers: [], iceLoopback: true });
  try {
    const sdp = await peer.createOffer();
    assert.equal(peer.offerSdp, sdp);
    const video = section(sdp, 'video');
    const pts = video.split('\n')[0].trim().split(' ').slice(3);
    assert.equal(pts.length, 1, 'exactly one video codec');
    const pt = pts[0];
    assert.match(video, new RegExp(`a=rtpmap:${pt} [hH]264/90000`));
    assert.match(video, new RegExp(`a=fmtp:${pt} ${VIDEO_FMTP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    for (const fb of ['nack', 'nack pli', 'goog-remb']) assert.match(video, new RegExp(`a=rtcp-fb:${pt} ${fb}\\r?\\n`));
    assert.match(video, /a=sendonly/);
    assert.doesNotMatch(video, /VP8|VP9|AV1|rtx/i);
    const audio = section(sdp, 'audio');
    assert.match(audio, /a=rtpmap:\d+ OPUS\/48000\/2/i);
    assert.match(audio, /minptime=10;useinbandfec=1/);
    assert.match(audio, /a=sendonly/);
    assert.match(sdp, /m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel/);
    const cands = lines(sdp, /^a=candidate:/);
    assert.ok(cands.length > 0);
    assert.ok(cands.every(c => / typ host( |$)/.test(c)), 'no server-reflexive or relay candidates');
    assert.ok(cands.some(c => / 127\.0\.0\.1 /.test(c)), 'loopback offered in test mode');
    assert.match(sdp, /a=end-of-candidates/, 'gathering finished before the offer was handed out');
    // The no-default-STUN fix: werift would otherwise ask stun.l.google.com.
    assert.equal(peer.pc.iceTransports[0].connection.stunServer, undefined);
    assert.equal(Object.keys(peer.channels).join(), 'control,input,pointer');
  } finally {
    await peer.close();
  }
});

test('production peers get the public STUN servers, passed explicitly', () => {
  const c = peerConfig({ iceServers: ICE_SERVERS });
  assert.deepEqual(c.iceServers, ICE_SERVERS);
  assert.notEqual(c.iceServers, ICE_SERVERS, 'a copy, so werift cannot change the shared constant');
  assert.equal(c.iceAdditionalHostAddresses, undefined, 'no loopback outside test mode');
  assert.equal(c.bundlePolicy, 'max-bundle');
});

test('both werift fixes are in place', () => {
  const r = applyWeriftPatches();
  assert.deepEqual(r, { noDefaultStun: true, unorderedFlag: true });
  assert.equal(RTCSctpTransport.prototype.dataChannelOpen.name, 'dataChannelOpenFixed');
});

test('a werift viewer connects; channels have the right labels and reliability; fingerprints are the SDPs\'', async () => {
  const { host, viewer, pc, offer, answer } = await connect();
  try {
    assert.equal(await waitConnected(host), 'connected');
    for (let i = 0; i < 100 && Object.keys(viewer.channels).length < 3; i++) await sleep(20);
    const ch = viewer.channels;
    assert.deepEqual(Object.keys(ch).sort(), ['control', 'input', 'pointer']);
    assert.equal(ch.control.ordered, true);
    assert.equal(ch.control.maxRetransmits, null, 'control is reliable');
    assert.equal(ch.input.ordered, true);
    assert.equal(ch.input.maxRetransmits, null, 'input is reliable');
    assert.equal(ch.pointer.ordered, false, 'pointer is unordered (werift fix 2)');
    assert.equal(ch.pointer.maxRetransmits, 0, 'pointer never retransmits');

    const info = host.dtlsInfo();
    assert.equal(info.state, 'connected');
    const fp = sdp => sdp.match(/a=fingerprint:(\S+) (\S+)/).slice(1).join(' ');
    assert.ok(info.local.includes(fp(offer)), 'our certificate is the one in our offer');
    assert.ok(info.remote.includes(fp(answer)), 'the viewer\'s is the one in its answer');
    assert.equal(host.answerSdp, answer);
    await assert.rejects(host.acceptAnswer(answer), /already/);

    // Text both ways on the control channel.
    const got = [];
    host.channels.control.onMessage.subscribe(d => got.push(String(d)));
    ch.control.send('{"t":"ping","n":1,"ts":2}');
    for (let i = 0; i < 100 && !got.length; i++) await sleep(10);
    assert.deepEqual(got, ['{"t":"ping","n":1,"ts":2}']);
  } finally {
    await host.close();
    await pc.close();
  }
});

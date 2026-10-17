// Video and sound on the way out: the H.264 packetizer (checked against werift's own depacketizer), RTP clocks, the
// pacer, bitrate control and the per-session sender.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { H264RtpPayload, RtcpRrPacket, RtcpPayloadSpecificFeedback } from 'werift';
import { splitAnnexB, groupAccessUnits, packetizeAccessUnit, depacketize, nalType, NAL } from '../src/h264.mjs';
import { Pacer, BitrateController, VideoClock, AudioClock, MediaSender, FLOOR_KBPS, RTP_MTU } from '../src/media.mjs';
import { QUALITY } from '../../../site/js/shared/proto.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const clip = () => groupAccessUnits(splitAnnexB(readFileSync(join(FIXTURES, 'clip.h264'))));

test('the fixture is what the app sends: Constrained Baseline, SPS and PPS before every IDR', () => {
  const aus = clip();
  assert.equal(aus.length, 90, '3 s at 30 fps');
  const keys = aus.filter(a => a.keyframe);
  assert.equal(keys.length, 3);
  for (const k of keys) {
    const types = k.nals.map(nalType);
    assert.ok(types.indexOf(NAL.SPS) < types.indexOf(NAL.IDR) && types.indexOf(NAL.PPS) < types.indexOf(NAL.IDR));
  }
  const sps = keys[0].nals.find(n => nalType(n) === NAL.SPS);
  assert.equal(sps[1], 66, 'profile_idc baseline');
  assert.equal(sps[2] & 0x40, 0x40, 'constraint_set1: constrained baseline');
});

test('packetizer: every frame round-trips, payloads fit, marker on the last packet, parameter sets in STAP-A', () => {
  let fu = 0, stap = 0, single = 0;
  for (const au of clip()) {
    const packets = packetizeAccessUnit(au.nals, { mtu: RTP_MTU });
    assert.ok(packets.length > 0);
    assert.equal(packets.at(-1).marker, true);
    assert.ok(packets.slice(0, -1).every(p => !p.marker));
    for (const p of packets) {
      assert.ok(p.payload.length <= RTP_MTU, `payload ${p.payload.length} > ${RTP_MTU}`);
      const t = p.payload[0] & 0x1f;
      if (t === NAL.FU_A) fu++; else if (t === NAL.STAP_A) stap++; else single++;
    }
    const back = depacketize(packets.map(p => p.payload));
    assert.equal(back.length, au.nals.length);
    back.forEach((n, i) => assert.ok(Buffer.from(n).equals(Buffer.from(au.nals[i]))));
    if (au.keyframe) assert.equal(packets[0].payload[0] & 0x1f, NAL.STAP_A, 'SPS + PPS (+ SEI) share the first packet');

    // werift's own H.264 depacketizer (what a receiver uses) gets the same Annex-B stream back.
    let frag;
    const out = [];
    for (const p of packets) {
      const h = H264RtpPayload.deSerialize(p.payload, frag);
      frag = h.fragment;
      if (h.payload) out.push(h.payload);
    }
    const expected = Buffer.concat(au.nals.map(n => Buffer.concat([Buffer.of(0, 0, 0, 1), n])));
    assert.ok(Buffer.concat(out).equals(expected), 'werift depacketizes our packets to the original frame');
  }
  assert.ok(fu > 0 && stap > 0 && single > 0, `all three packet kinds used (FU-A ${fu}, STAP-A ${stap}, single ${single})`);
});

test('FU-A fragments keep the NAL header bits and set start/end flags', () => {
  const nal = Buffer.alloc(3000, 7);
  nal[0] = 0x65; // NRI 3, IDR
  const packets = packetizeAccessUnit([nal], { mtu: 1200 });
  assert.equal(packets.length, 3);
  for (const [i, p] of packets.entries()) {
    assert.equal(p.payload[0], 0x60 | NAL.FU_A);
    assert.equal(p.payload[1] & 0x1f, NAL.IDR);
    assert.equal(!!(p.payload[1] & 0x80), i === 0, 'S bit');
    assert.equal(!!(p.payload[1] & 0x40), i === 2, 'E bit');
  }
  // Annex-B with 3- and 4-byte start codes and an access unit delimiter (which is never sent).
  const annexB = Buffer.concat([Buffer.of(0, 0, 0, 1, 0x09, 0xf0), Buffer.of(0, 0, 1), Buffer.of(0x67, 1, 2), Buffer.of(0, 0, 0, 1), Buffer.of(0x68, 3)]);
  const nals = splitAnnexB(annexB);
  assert.deepEqual(nals.map(n => [...n]), [[0x09, 0xf0], [0x67, 1, 2], [0x68, 3]]);
  const p = packetizeAccessUnit(nals);
  assert.equal(p.length, 1);
  assert.deepEqual(depacketize(p.map(x => x.payload)).map(n => [...n]), [[0x67, 1, 2], [0x68, 3]]);
});

test('RTP clocks: 90 kHz video that never goes backwards, 48 kHz audio in steps of 960', () => {
  const v = new VideoClock();
  const a = v.ts(1_000_000);
  assert.equal(v.ts(1_033_333), (a + 3000) % 2 ** 32);
  assert.equal(v.ts(2_000_000), (a + 90000) % 2 ** 32);
  // The app restarted capture and its clock started again: RTP time keeps going forward.
  const after = v.ts(5);
  assert.ok(((after - (a + 90000)) >>> 0) > 0 && ((after - (a + 90000)) >>> 0) < 10000);

  const c = new AudioClock();
  const first = c.next(500_000);
  assert.equal(first.marker, true);
  const second = c.next(520_000);
  assert.equal(second.marker, false);
  assert.equal((second.ts - first.ts) >>> 0, 960);
  const late = c.next(540_400); // a little jitter stays on the grid
  assert.equal((late.ts - second.ts) >>> 0, 960);
  const gap = c.next(700_000); // capture paused
  assert.equal(gap.marker, true, 'first packet after a gap is marked');
  assert.equal((gap.ts - first.ts) >>> 0, 10 * 960);
  const dup = c.next(700_000); // the same timestamp twice still moves on
  assert.equal((dup.ts - gap.ts) >>> 0, 960);
});

function fakeClock() {
  let t = 0;
  return { now: () => t, tick: ms => { t += ms; } };
}

test('pacer: a big keyframe leaves over several ticks within ~2.5x the target rate', async () => {
  const clock = fakeClock();
  const sent = [];
  const pacer = new Pacer({ rateKbps: () => 4000, send: p => sent.push({ at: clock.now(), bytes: p.payload.length }), now: clock.now });
  const packets = Array.from({ length: 100 }, () => ({ payload: Buffer.alloc(1200), marker: false }));
  packets.at(-1).marker = true;
  pacer.push({ packets, bytes: 120000, keyframe: true, ts: 1 });
  clearInterval(pacer.timer); // drive it by hand
  pacer.timer = null;
  for (let i = 0; i < 400 && sent.length < 100; i++) { clock.tick(5); pacer._tick(); }
  assert.equal(sent.length, 100);
  // 4000 kbps × 2.5 = 1250 bytes per ms: 120 kB takes about 96 ms, never all at once.
  const span = sent.at(-1).at - sent[0].at;
  assert.ok(span >= 80 && span <= 120, `spread over ${span} ms`);
  const perTick = new Map();
  for (const s of sent) perTick.set(s.at, (perTick.get(s.at) ?? 0) + s.bytes);
  assert.ok(Math.max(...perTick.values()) <= 2 * 5 * 1250 + 1300, 'no tick sends more than two ticks of budget');
  pacer.stop();
});

test('pacer: when far behind it drops what is queued and asks for a keyframe', () => {
  const clock = fakeClock();
  let overflows = 0;
  const pacer = new Pacer({ rateKbps: () => FLOOR_KBPS, send: () => {}, now: clock.now, onOverflow: () => overflows++ });
  const frame = keyframe => ({ packets: Array.from({ length: 50 }, () => ({ payload: Buffer.alloc(1200) })), bytes: 60000, keyframe, ts: 0 });
  assert.equal(pacer.push(frame(false)), true);
  clearInterval(pacer.timer);
  pacer.timer = null;
  clock.tick(400);
  assert.equal(pacer.push(frame(false)), false, 'refused: the queue is 400 ms behind');
  assert.equal(overflows, 1);
  assert.equal(pacer.queue.length, 0);
  assert.equal(pacer.push(frame(true)), true, 'a keyframe is always taken');
  pacer.stop();
});

test('bitrate: backs off on loss and on REMB, creeps up when clean, stays within the floor and the ceiling', () => {
  const clock = fakeClock();
  const targets = [];
  const b = new BitrateController({ preset: QUALITY.balanced, now: clock.now, onTarget: k => targets.push(k) });
  assert.equal(b.target, 5000);
  assert.equal(b.link, 'good');
  clock.tick(1000);
  b.onReport({ fractionLost: 0.3, rtt: 0.05 });
  assert.equal(b.target, 4250);
  assert.deepEqual(targets, [4250], 'a >10% change is reported');
  b.onReport({ fractionLost: 0.12 });
  assert.equal(targets.length, 1, 'a small further change is not reported');
  assert.equal(b.link, 'slow');
  for (let i = 0; i < 40; i++) { clock.tick(10000); b.onReport({ fractionLost: 0.5 }); }
  assert.equal(b.target, FLOOR_KBPS);
  for (let i = 0; i < 200; i++) { clock.tick(1500); b.onReport({ fractionLost: 0, rtt: 0.03 }); }
  assert.equal(b.target, QUALITY.balanced.maxKbps, 'never above the preset ceiling');
  assert.equal(b.link, 'good');
  // The browser says it can only take 2 Mbps.
  clock.tick(1000);
  b.onRemb(2_000_000);
  assert.equal(b.target, 1800);
  // ... and while the browser keeps saying so (REMB comes about once a second), growth stops at its estimate.
  for (let i = 0; i < 10; i++) { clock.tick(3000); b.onRemb(2_000_000); b.onReport({ fractionLost: 0 }); }
  assert.equal(b.target, 2000, 'grows up to the estimate and no further');
  // REMB in the first two seconds of a preset is ignored (the browser's estimate starts low).
  b.setPreset(QUALITY.smooth);
  b.onRemb(100_000);
  assert.equal(b.target, QUALITY.smooth.kbps);
});

// Something shaped like werift's RTCRtpSender, for the sender tests.
function fakeSender(ssrc) {
  const subs = { pli: [], rtcp: [] };
  const ev = list => ({ subscribe: fn => { list.push(fn); return { unSubscribe: () => list.splice(list.indexOf(fn), 1) }; } });
  return {
    ssrc, rtt: 0.04, sent: [],
    sendRtp(p) { this.sent.push(p); return Promise.resolve(); },
    onPictureLossIndication: ev(subs.pli),
    onRtcp: ev(subs.rtcp),
    pli: () => subs.pli.forEach(f => f()),
    rtcp: p => subs.rtcp.forEach(f => f(p)),
    subs,
  };
}

test('sender: nothing before start, waits for a keyframe, throttles keyframe requests, reacts to feedback', async () => {
  const video = fakeSender(1111), audio = fakeSender(2222);
  let t = 0;
  const keyframes = [], bitrates = [];
  const m = new MediaSender({ video, audio, quality: 'smooth', now: () => t, onKeyframe: () => keyframes.push(t), onBitrate: k => bitrates.push(k) });
  const aus = clip();
  const frame = i => ({ keyframe: aus[i].keyframe, ptsUs: i * 33333, data: Buffer.concat(aus[i].nals.flatMap(n => [Buffer.of(0, 0, 0, 1), n])) });
  m.pushVideo(frame(0));
  m.pushAudio({ ptsUs: 0, data: Buffer.alloc(80) });
  assert.equal(video.sent.length + audio.sent.length, 0, 'nothing is sent before start()');

  m.start();
  assert.deepEqual(keyframes, [0], 'start asks for a keyframe');
  m.pushVideo(frame(1));
  assert.equal(video.sent.length, 0, 'a frame that is not a keyframe is skipped while waiting for one');
  t += 600;
  m.pushVideo(frame(2));
  assert.deepEqual(keyframes, [0, 600], 'and asks again, at most every 500 ms');
  m.pushVideo(frame(30));
  await new Promise(r => setTimeout(r, 50));
  assert.ok(video.sent.length > 0);
  assert.ok(video.sent.at(-1).header.marker);
  const seqs = video.sent.map(p => p.header.sequenceNumber);
  assert.ok(seqs.every((s, i) => i === 0 || s === ((seqs[i - 1] + 1) & 0xffff)), 'sequence numbers follow on');
  m.pushAudio({ ptsUs: 1000000, data: Buffer.alloc(80) });
  m.pushAudio({ ptsUs: 1020000, data: Buffer.alloc(80) });
  assert.equal(audio.sent.length, 2);
  assert.equal((audio.sent[1].header.timestamp - audio.sent[0].header.timestamp) >>> 0, 960);

  // PLIs: several in a burst make one keyframe request.
  t += 1000;
  video.pli(); video.pli(); video.pli();
  assert.equal(keyframes.length, 3);
  assert.equal(m.totals.plis, 3);

  // A receiver report with heavy loss for our stream lowers the bitrate; one for another stream doesn't.
  t += 1000;
  video.rtcp({ type: RtcpRrPacket.type, reports: [{ ssrc: 9999, fractionLost: 200 }] });
  assert.equal(bitrates.length, 0);
  video.rtcp({ type: RtcpRrPacket.type, reports: [{ ssrc: 1111, fractionLost: 128 }] });
  assert.deepEqual(bitrates, [1875]);
  // REMB (payload-specific feedback, format 15).
  t += 3000;
  video.rtcp({ type: RtcpPayloadSpecificFeedback.type, feedback: { count: 15, bitrate: 900_000n } });
  assert.deepEqual(bitrates, [1875, 810]);

  const s = m.sample();
  assert.equal(s.link, 'slow');
  assert.ok(s.kbps >= 0 && s.fps >= 0);
  m.stop();
  assert.equal(video.subs.pli.length + video.subs.rtcp.length, 0, 'stop() lets go of the sender');
  m.pushVideo(frame(60));
  await new Promise(r => setTimeout(r, 20));
  const n = video.sent.length;
  m.pushVideo(frame(61));
  assert.equal(video.sent.length, n, 'nothing after stop()');
});

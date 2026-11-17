// Video and sound on the way out: the H.264 packetizer (checked against werift's own depacketizer), RTP clocks, the
// pacer, bitrate control and the per-session sender.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolutionGovernor, ladderAtLeast } from '../src/media.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { H264RtpPayload, RtcpRrPacket, RtcpPayloadSpecificFeedback } from 'werift';
import { splitAnnexB, groupAccessUnits, packetizeAccessUnit, depacketize, nalType, NAL } from '../src/h264.mjs';
import { Pacer, BitrateController, VideoClock, AudioClock, MediaSender, FLOOR_KBPS, RTP_MTU, LOSS_MIN_PACKETS,
  CEILING_MEMORY_MS, LINK_SLOW_AFTER_MS, LINK_GOOD_AFTER_MS } from '../src/media.mjs';
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
  // A keyframe that arrives when the queue is far behind is itself the fresh start: the caller is told so, and must
  // not go on waiting for (and asking for) yet another keyframe.
  const fresh = [];
  const p2 = new Pacer({ rateKbps: () => FLOOR_KBPS, send: () => {}, now: clock.now, onOverflow: k => fresh.push(k) });
  p2.push(frame(false));
  clearInterval(p2.timer);
  p2.timer = null;
  clock.tick(400);
  assert.equal(p2.push(frame(true)), true);
  assert.deepEqual(fresh, [true]);
  assert.equal(p2.queue.length, 1, 'only the keyframe is queued');
  pacer.stop();
  p2.stop();
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
  assert.equal(b.link, 'good', 'one bad report is not a slow connection yet');
  b.onReport({ fractionLost: 0.12 });
  assert.equal(targets.length, 1, 'a small further change is not reported');
  clock.tick(LINK_SLOW_AFTER_MS);
  assert.equal(b.link, 'slow', 'still losing a few seconds on: slow');
  for (let i = 0; i < 40; i++) { clock.tick(10000); b.onReport({ fractionLost: 0.5 }); }
  assert.equal(b.target, FLOOR_KBPS);
  for (let i = 0; i < 200; i++) { clock.tick(1500); b.onReport({ fractionLost: 0, rtt: 0.03 }); }
  assert.equal(b.target, QUALITY.balanced.maxKbps, 'never above the preset ceiling');
  assert.equal(b.link, 'good');
  // The browser says it can only take 2 Mbps: followed down, but by at most half at a time, once a second.
  clock.tick(1000);
  b.onRemb(2_000_000);
  assert.equal(b.target, QUALITY.balanced.maxKbps / 2, 'one estimate halves the target at most');
  clock.tick(500);
  b.onRemb(2_000_000);
  assert.equal(b.target, QUALITY.balanced.maxKbps / 2, 'and not twice within a second');
  for (let i = 0; i < 3; i++) { clock.tick(1000); b.onRemb(2_000_000); }
  assert.equal(b.target, 1800, 'repeated estimates still get all the way down');
  // ... and while the browser keeps saying so (REMB comes about once a second), growth stops at its estimate.
  for (let i = 0; i < 10; i++) { clock.tick(3000); b.onRemb(2_000_000); b.onReport({ fractionLost: 0 }); }
  assert.equal(b.target, 2000, 'grows up to the estimate and no further');
  // REMB in the first two seconds of a preset is ignored (the browser's estimate starts low).
  b.setPreset(QUALITY.smooth);
  b.onRemb(100_000);
  assert.equal(b.target, QUALITY.smooth.kbps);
});

test('bitrate: a low estimate after a still screen is not believed, and a real cut recovers quickly', () => {
  const clock = fakeClock();
  let sent = 5000;
  const b = new BitrateController({ preset: QUALITY.balanced, now: clock.now, sentKbps: () => sent });
  clock.tick(5000);
  // The screen has been still: 200 kbit/s going out, so the browser's estimate has sunk to about 1.5 times that.
  sent = 200;
  b.onRemb(320_000);
  assert.equal(b.target, 5000, 'the estimate only reflects how little was sent');
  for (let i = 0; i < 5; i++) { clock.tick(1500); b.onRemb(320_000); b.onReport({ fractionLost: 0 }); }
  assert.ok(b.target >= 5000, 'and it does not hold the target down either');
  // A delay blip while quiet: Chrome reports 85% of the trickle it receives, below even what is being sent. That
  // used to floor the target (10 Mbit/s to ~500 kbit/s in host.log) and the picture with it; it says nothing about
  // the link, so it is not believed either.
  b.onRemb(170_000);
  assert.equal(b.target, 5000, 'a blip on a still screen does not floor the bitrate');
  // Busy again, and now the browser really is getting too much: followed down.
  sent = 5000;
  clock.tick(1100);
  b.onRemb(3_000_000);
  assert.equal(b.target, 2700);
  // The link is fine after all: back to the preset's bitrate within a few seconds, not half a minute.
  let steps = 0;
  while (b.target < QUALITY.balanced.kbps && steps < 60) {
    clock.tick(1100);
    sent = b.target * 0.95;
    b.onRemb(sent * 1500);
    b.onReport({ fractionLost: 0 });
    steps++;
  }
  assert.ok(steps <= 14, `recovered in ${steps} steps`);
});

test('bitrate: a blip is not a slow connection; the note comes and goes only after a few seconds', () => {
  const clock = fakeClock();
  const b = new BitrateController({ preset: QUALITY.balanced, now: clock.now });
  // Wi-Fi hiccups: a burst of loss every ten seconds, clean in between. The numbers flick to "slow" each time, but
  // never stay there long enough to tell the viewer the connection is slow.
  for (let i = 0; i < 10; i++) {
    clock.tick(500);
    b.onReport({ fractionLost: 0.2, rtt: 0.02 });
    assert.equal(b.link, 'good', `hiccup ${i}`);
    for (let j = 0; j < 19; j++) {
      clock.tick(500);
      b.onReport({ fractionLost: 0, rtt: 0.02 });
      assert.equal(b.link, 'good', `hiccup ${i}, ${j * 500 + 500} ms on`);
    }
  }
  // Really slow: losing steadily. Said once it has lasted LINK_SLOW_AFTER_MS.
  const c = new BitrateController({ preset: QUALITY.balanced, now: clock.now });
  let slowAt = null;
  const from = clock.now();
  for (let i = 0; i < 20 && slowAt === null; i++) {
    clock.tick(500);
    c.onReport({ fractionLost: 0.15, rtt: 0.02 });
    if (c.link === 'slow') slowAt = clock.now() - from;
  }
  assert.ok(slowAt !== null && slowAt >= LINK_SLOW_AFTER_MS && slowAt <= LINK_SLOW_AFTER_MS + 1000, `slow after ${slowAt} ms`);
  // Fine again: the note stays until the link has been fine for LINK_GOOD_AFTER_MS, and the target is back.
  const cleanFrom = clock.now();
  let goodAt = null;
  for (let i = 0; i < 200 && goodAt === null; i++) {
    clock.tick(500);
    c.onReport({ fractionLost: 0, rtt: 0.02 });
    if (c.link === 'good') goodAt = clock.now() - cleanFrom;
  }
  assert.ok(goodAt !== null && goodAt >= LINK_GOOD_AFTER_MS, `good again after ${goodAt} ms`);
});

test('bitrate: near where the link last ran out it creeps instead of leaping, and a quiet screen never probes', () => {
  const clock = fakeClock();
  let sent = 10000;
  const b = new BitrateController({ preset: QUALITY.sharp, now: clock.now, sentKbps: () => sent });
  clock.tick(5000);
  // Busy at 10 Mbit/s and losing 40%: the link ran out at 10 Mbit/s.
  b.onReport({ fractionLost: 0.4 });
  assert.equal(b.target, 8000);
  assert.equal(b.ceiling, 10000);
  // Loss reported again a moment later is the same burst: not cut twice.
  clock.tick(100);
  b.onReport({ fractionLost: 0.4 });
  assert.equal(b.target, 8000, 'one cut per round trip');
  // Clean again: quickly back to 85% of the ceiling, then only 3% a second.
  const seen = [];
  for (let i = 0; i < 6; i++) {
    clock.tick(2100);
    sent = b.target;
    b.onReport({ fractionLost: 0 });
    seen.push(b.target);
  }
  assert.equal(seen[0], 8500, 'back to 85% of where it ran out, no further in one go');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] <= Math.ceil(seen[i - 1] * 1.03), `step ${i}: ${seen[i - 1]} → ${seen[i]}`);
  // Half a minute later the ceiling is forgotten and normal probing resumes.
  clock.tick(40000);
  sent = b.target;
  const before = b.target;
  b.onReport({ fractionLost: 0 });
  assert.ok(b.target >= Math.round(before * 1.08), `${before} → ${b.target}`);

  // A still screen (little going out) brings the target back to the preset's bitrate but never probes above it.
  const q = new BitrateController({ preset: QUALITY.sharp, now: clock.now, sentKbps: () => 200 });
  for (let i = 0; i < 30; i++) { clock.tick(2100); q.onReport({ fractionLost: 0 }); }
  assert.equal(q.target, QUALITY.sharp.kbps);

  // Switching preset keeps what was learned: Sharp right after the link ran out at 4 Mbit/s starts below that.
  const c = new BitrateController({ preset: QUALITY.balanced, now: clock.now, sentKbps: () => 4000 });
  clock.tick(5000);
  c.target = 4000;
  c.onReport({ fractionLost: 0.3 });
  c.setPreset(QUALITY.sharp);
  assert.equal(c.target, 3400, '85% of the 4 Mbit/s the link ran out at, not 10 Mbit/s');
  clock.tick(CEILING_MEMORY_MS + 1);
  c.setPreset(QUALITY.balanced);
  c.setPreset(QUALITY.sharp);
  assert.equal(c.target, QUALITY.sharp.kbps, 'an old ceiling is forgotten');
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
  // REMB (payload-specific feedback, format 15). Nothing has been sent for seconds, so a low estimate only reflects
  // that; with video flowing again, an estimate below what is being sent is real congestion and is obeyed (by at
  // most half at a time).
  t += 3000;
  video.rtcp({ type: RtcpPayloadSpecificFeedback.type, feedback: { count: 15, bitrate: 900_000n } });
  assert.deepEqual(bitrates, [1875], 'not believed while nothing is going out');
  assert.equal(m.sentKbps(), 0);
  m.recent.push([t, 250_000]);
  m.recentBytes += 250_000;
  assert.equal(m.sentKbps(), 2000);
  video.rtcp({ type: RtcpPayloadSpecificFeedback.type, feedback: { count: 15, bitrate: 900_000n } });
  assert.deepEqual(bitrates, [1875, 938]);

  t += LINK_SLOW_AFTER_MS;
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

test('sender: loss is judged over at least 50 packets, from the reports\' running totals', () => {
  const video = fakeSender(1111);
  let t = 10000;
  const m = new MediaSender({ video, quality: 'smooth', now: () => t });
  m.start();
  const rr = (highestSequence, packetsLost, fractionLost = 0) =>
    video.rtcp({ type: RtcpRrPacket.type, reports: [{ ssrc: 1111, highestSequence, packetsLost, fractionLost }] });
  rr(1000, 0);
  // Chrome sends a report with every NACK: three packets, one lost, its own fraction says 33%. Not a judgement yet.
  t += 50;
  rr(1003, 1, 85);
  assert.equal(m.bitrate.target, QUALITY.smooth.kbps, 'a handful of packets is not enough to judge');
  // Once 50 or more have been expected, the loss over all of them counts: 2 of 60 is 3%, no cut.
  t += 50;
  rr(1060, 2);
  assert.equal(m.bitrate.target, QUALITY.smooth.kbps);
  // 30 lost out of the next 100: a real cut, by half the loss rate.
  t += 1000;
  rr(1160, 32);
  assert.equal(m.bitrate.target, Math.round(QUALITY.smooth.kbps * 0.85));
  // The running total is a signed 24-bit number: duplicates can take it below zero without reading as 16 million.
  t += 3000;
  rr(1260, 0xffffff);
  const after = m.bitrate.target;
  assert.ok(after >= Math.round(QUALITY.smooth.kbps * 0.85), 'read as no loss (and a step back up), not a cut');
  assert.ok(m.bitrate.loss < 0.2);
  // The stream restarting (a lower highest sequence) starts counting again.
  rr(10, 0);
  t += 100;
  rr(20, 5);
  assert.equal(m.bitrate.target, after, '5 of 10 is too few to judge');
  assert.equal(LOSS_MIN_PACKETS, 50);
  m.stop();
});

test('picture size: steps down when the link can\'t carry it, back up slowly, never past the viewer\'s screen', () => {
  assert.equal(ladderAtLeast(1170), 1280);
  assert.equal(ladderAtLeast(1920), 1920);
  assert.equal(ladderAtLeast(5000), 2880);
  const g = new ResolutionGovernor({ fps: 30 });
  // Plenty of bitrate for 1920: no limit.
  for (let i = 0; i < 10; i++) assert.equal(g.update(5000, 1920), undefined);
  assert.equal(g.cap, null);
  // The link drops to 1 Mbit/s: one reading is not enough, two are; 1280 is what 1 Mbit/s carries.
  assert.equal(g.update(1000, 1920), undefined);
  assert.equal(g.update(1000, 1920), 1280);
  // A brief dip and recovery in between doesn't count.
  assert.equal(g.update(600, 1920), undefined);
  assert.equal(g.update(1000, 1920), undefined);
  assert.equal(g.update(600, 1920), undefined);
  assert.equal(g.update(600, 1920), 960);
  // Back up one step at a time, only after five good readings in a row with room to spare.
  for (let i = 0; i < 4; i++) assert.equal(g.update(6000, 1920), undefined);
  assert.equal(g.update(6000, 1920), 1280);
  for (let i = 0; i < 4; i++) g.update(6000, 1920);
  assert.equal(g.update(6000, 1920), 1600);
  for (let i = 0; i < 4; i++) g.update(6000, 1920);
  assert.equal(g.update(6000, 1920), null, 'at the top again: no limit');
  // Barely enough for the next size is not enough to step up (it would step straight back down).
  const h = new ResolutionGovernor();
  h.update(1000, 1920); h.update(1000, 1920);
  for (let i = 0; i < 20; i++) assert.equal(h.update(1600, 1920), undefined, 'needs a quarter to spare for 1600');
  assert.equal(h.cap, 1280);
  // 60 frames a second needs half as much again.
  const f = new ResolutionGovernor({ fps: 60 });
  f.update(3000, 1920);
  assert.equal(f.update(3000, 1920), 1600);
});

test('frame rate: up to 60 only after a few readings with room to spare, back to 30 at once when the link tightens', async () => {
  const { FpsGovernor } = await import('../src/media.mjs');
  const g = new FpsGovernor();
  g.set(30, 60);
  assert.equal(g.fps, 30);
  // 1920 wide needs 2200 kbit/s at 30, so 3300 at 60; with the 30% margin, 4290.
  for (let i = 0; i < 3; i++) assert.equal(g.update(5000, 2200), undefined, 'not after one or two good readings');
  assert.equal(g.update(5000, 2200), 60, 'the fourth in a row');
  assert.equal(g.update(3000, 2200), undefined, 'one short reading is not enough to drop');
  assert.equal(g.update(3000, 2200), 30, 'two are');
  // Never above 30 for a preset that doesn't allow it, never below 60 for one fixed at 60.
  g.set(30, 30);
  for (let i = 0; i < 6; i++) assert.equal(g.update(50000, 500), undefined);
  assert.equal(g.fps, 30);
  g.set(60, 60);
  assert.equal(g.update(100, 5000), undefined);
  assert.equal(g.fps, 60);
  // A tiny picture still wants a sensible link before going to 60 (at least 1.5 Mbit/s plus the margin).
  g.set(30, 60);
  for (let i = 0; i < 4; i++) g.update(1800, 0);
  assert.equal(g.fps, 30);
  for (let i = 0; i < 4; i++) g.update(2000, 0);
  assert.equal(g.fps, 60);
});

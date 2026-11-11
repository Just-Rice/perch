// Sending the Mac's video and sound to the one signed-in viewer.
//
// Video frames arrive from the app as H.264 access units with microsecond timestamps. Each frame is cut into RTP
// packets (src/h264.mjs) and handed to a pacer, so a big keyframe leaves over a few milliseconds instead of as one
// burst that would overflow router buffers. A bitrate controller listens to what the browser reports back (packet
// loss in receiver reports, its bandwidth estimate in REMB) and tells the app's encoder to aim higher or lower.
// Audio is small and steady (one Opus packet every 20 ms), so it skips the pacer.
import { RtpHeader, RtpPacket, RtcpRrPacket, RtcpSrPacket, RtcpPayloadSpecificFeedback } from 'werift';
import { QUALITY, DEFAULT_QUALITY, EDGE_LADDER, EDGE_NEEDS_KBPS } from '../../../site/js/shared/proto.js';
import { splitAnnexB, packetizeAccessUnit } from './h264.mjs';

export const FLOOR_KBPS = 300;
export const RTP_MTU = 1200;
const KEYFRAME_MIN_GAP_MS = 500;
const REMB_FEEDBACK_COUNT = 15;
const U32 = 2 ** 32;

const randomU32 = () => Math.floor(Math.random() * U32);
const randomU16 = () => Math.floor(Math.random() * 65536);

// --- bitrate control ---

// Starts at the quality preset's bitrate, backs off quickly when the browser reports loss (or estimates less
// bandwidth than we send), and creeps back up while the link stays clean. Reports a new target only when it moved by
// more than 10%, so the encoder isn't reconfigured for every small wobble.
export class BitrateController {
  // sentKbps: what is actually going out right now (measured), or null when unknown.
  constructor({ preset = QUALITY[DEFAULT_QUALITY], now = () => Date.now(), onTarget = () => {}, sentKbps = () => null } = {}) {
    this.now = now;
    this.onTarget = onTarget;
    this.sentKbps = sentKbps;
    this.setPreset(preset);
  }

  setPreset(preset) {
    this.preset = preset;
    this.target = preset.kbps;
    this.reported = preset.kbps;
    this.startedAt = this.now();
    this.lastDecrease = 0;
    this.lastIncrease = this.startedAt;
    this.loss = 0;          // smoothed fraction lost (0..1)
    this.rtt = 0;           // seconds
    this.remb = 0;          // kbps, 0 = none yet
    this.rembAt = 0;
  }

  _clamp(kbps) {
    return Math.round(Math.max(FLOOR_KBPS, Math.min(this.preset.maxKbps, kbps)));
  }

  _set(kbps) {
    this.target = this._clamp(kbps);
    if (Math.abs(this.target - this.reported) > this.reported * 0.1) {
      this.reported = this.target;
      this.onTarget(this.target);
    }
  }

  // A receiver report for our video stream: fractionLost is 0..1 for the last interval, rtt in seconds (or undefined).
  onReport({ fractionLost, rtt }) {
    const t = this.now();
    if (Number.isFinite(rtt)) this.rtt = rtt;
    this.loss = this.loss * 0.6 + fractionLost * 0.4;
    if (fractionLost > 0.1) {
      // Same rule as Google's congestion control: cut by half the loss rate.
      this._set(this.target * (1 - 0.5 * fractionLost));
      this.lastDecrease = t;
    } else if (fractionLost < 0.02 && t - this.lastDecrease > 2000 && t - this.lastIncrease > 1000) {
      // Recover quickly up to the preset's own bitrate (a cut is usually a passing blip), then probe gently above it.
      let next = this.target * (this.target < this.preset.kbps ? 1.25 : 1.08);
      // The browser's estimate is a ceiling only while we are really using the link (see onRemb).
      if (this.remb && t - this.rembAt < 5000 && !this._appLimited()) next = Math.min(next, Math.max(this.target, this.remb));
      this._set(next);
      this.lastIncrease = t;
    }
  }

  // True while much less is going out than the target allows: a still screen needs almost no data. The browser's
  // bandwidth estimate (REMB) can't grow beyond about 1.5 times what it receives, so in that state a low estimate
  // describes our own quietness, not the link.
  _appLimited() {
    const sent = this.sentKbps();
    return sent !== null && sent < this.target * 0.6;
  }

  // REMB: the browser's estimate of how much it can receive, in bits per second.
  onRemb(bps) {
    const t = this.now();
    this.remb = bps / 1000;
    this.rembAt = t;
    // Ignore the first two seconds: the browser's estimate starts low and ramps up as data arrives.
    if (t - this.startedAt < 2000) return;
    if (this.remb >= this.target * 0.9) return;
    // After a still screen the estimate is low only because little was sent. Cutting the target to it would leave
    // the next burst of movement starved for many seconds (dropped frames, a blurry picture). Only believe a low
    // estimate when it is below what is actually being sent: that is real congestion.
    const sent = this.sentKbps();
    if (sent !== null && sent < this.target * 0.6 && this.remb > sent * 1.2) return;
    this._set(this.remb * 0.9);
    this.lastDecrease = t;
  }

  get link() {
    const slow = this.loss > 0.05 || this.rtt > 0.35 || this.target < this.preset.kbps * 0.5;
    return slow ? 'slow' : 'good';
  }
}

// --- picture size ---

// The smallest ladder size that is at least `px` (the viewer's screen), or the largest there is.
export function ladderAtLeast(px) {
  return EDGE_LADDER.find(e => e >= px) ?? EDGE_LADDER.at(-1);
}

// Chooses the picture size the link can carry at full frame rate. Fed the bitrate target every couple of seconds:
// steps down after two readings in a row say the current size needs more than the link gives, and back up one step
// at a time only after five readings in a row with a quarter to spare, so it doesn't flap.
export class ResolutionGovernor {
  constructor({ fps = 30 } = {}) {
    this.setFps(fps);
    this.cap = null;   // longest edge allowed right now, or null for "no limit from the link"
    this.down = 0;
    this.up = 0;
  }

  setFps(fps) { this.factor = fps > 30 ? 1.5 : 1; }

  reset() { this.cap = null; this.down = this.up = 0; }

  need(edge) { return (EDGE_NEEDS_KBPS[edge] ?? 0) * this.factor; }

  // `ceiling`: the largest size wanted anyway (the quality preset and the viewer's screen). Returns the new cap when
  // it changed (null = back to no limit), otherwise undefined.
  update(targetKbps, ceiling) {
    const steps = EDGE_LADDER.filter(e => e <= ceiling);
    if (!steps.length) return undefined;
    const top = steps.at(-1);
    const current = Math.min(this.cap ?? top, top);
    const fit = steps.filter(e => this.need(e) <= targetKbps).at(-1) ?? steps[0];
    if (fit < current) {
      this.up = 0;
      if (++this.down < 2) return undefined;
      this.down = 0;
      this.cap = fit;
      return this.cap;
    }
    this.down = 0;
    if (this.cap !== null && current < top) {
      const next = steps[steps.indexOf(current) + 1] ?? top;
      if (this.need(next) * 1.25 <= targetKbps) {
        if (++this.up < 5) return undefined;
        this.up = 0;
        this.cap = next >= top ? null : next;
        return this.cap;
      }
    }
    this.up = 0;
    return undefined;
  }
}

// --- pacing ---

// Sends queued video packets at up to `burst` times the target bitrate, in 5 ms ticks. If the queue falls more than
// `maxQueueMs` behind (the encoder overshot badly), everything queued is dropped and a keyframe is requested,
// because a late frame is worth less than a fresh one. A keyframe at the head of the queue gets extra time for its
// own size, so a big keyframe on a slow link is not dropped over and over.
export class Pacer {
  constructor({ rateKbps, send, onOverflow = () => {}, now = () => performance.now(), tickMs = 5, burst = 2.5, maxQueueMs = 300 }) {
    Object.assign(this, { rateKbps, send, onOverflow, now, tickMs, burst, maxQueueMs });
    this.queue = [];   // frames: {packets, next, bytes, keyframe, at, ts}
    this.tokens = 0;   // bytes we may still send now
    this.last = now();
    this.timer = null;
    this.drops = 0;
  }

  get queuedBytes() {
    let n = 0;
    for (const f of this.queue) for (let i = f.next; i < f.packets.length; i++) n += f.packets[i].payload.length;
    return n;
  }

  _bytesPerMs() {
    return Math.max(FLOOR_KBPS, this.rateKbps()) * this.burst / 8;
  }

  // Returns false when the frame was refused because the queue overflowed (the caller then waits for a keyframe).
  push(frame) {
    const t = this.now();
    if (this.queue.length) {
      const head = this.queue[0];
      const allowance = this.maxQueueMs + (head.keyframe ? head.bytes / this._bytesPerMs() : 0);
      if (t - head.at > allowance) {
        this.clear();
        this.drops++;
        // A keyframe arriving now is itself the fresh start; anything else needs one asked for.
        this.onOverflow(!!frame.keyframe);
        if (!frame.keyframe) return false;
      }
    }
    this.queue.push({ ...frame, next: 0, at: t });
    this._tick();
    if (this.queue.length && !this.timer) this.timer = setInterval(() => this._tick(), this.tickMs);
    return true;
  }

  _tick() {
    const t = this.now();
    const rate = this._bytesPerMs();
    // Refill, but never save up more than two ticks' worth: an idle second must not turn into a burst.
    this.tokens = Math.min(this.tokens + (t - this.last) * rate, Math.max(2 * this.tickMs * rate, RTP_MTU + 100));
    this.last = t;
    while (this.queue.length && this.tokens > 0) {
      const f = this.queue[0];
      const p = f.packets[f.next++];
      this.tokens -= p.payload.length;
      try { this.send(p, f); } catch {}
      if (f.next >= f.packets.length) this.queue.shift();
    }
    if (!this.queue.length && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  clear() {
    this.queue = [];
  }

  stop() {
    this.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// --- RTP timestamps ---

// 90 kHz video clock from the app's microsecond timestamps. If the app restarts capture its clock may jump back;
// RTP time must keep moving forward, so we carry on from the last value.
export class VideoClock {
  constructor() { this.base = randomU32(); this.pts0 = null; this.lastPts = 0; this.lastTs = null; }
  ts(ptsUs) {
    if (this.pts0 === null || ptsUs < this.lastPts) {
      if (this.lastTs !== null) this.base = (this.lastTs + 3000) % U32;
      this.pts0 = ptsUs;
    }
    this.lastPts = ptsUs;
    this.lastTs = (this.base + Math.round((ptsUs - this.pts0) * 0.09)) % U32;
    return this.lastTs;
  }
}

// 48 kHz Opus clock in steps of 960 samples (20 ms). A gap in the app's timestamps (a pause in capture) becomes the
// same gap in RTP time, and the first packet after one carries the marker bit, as RFC 7587 asks.
export class AudioClock {
  constructor() { this.base = randomU32(); this.pts0 = null; this.lastStep = -1; }
  next(ptsUs) {
    if (this.pts0 === null) this.pts0 = ptsUs;
    let step = Math.round((ptsUs - this.pts0) / 20000);
    if (step <= this.lastStep) step = this.lastStep + 1;
    const marker = step !== this.lastStep + 1 || this.lastStep < 0;
    this.lastStep = step;
    return { ts: (this.base + step * 960) % U32, marker };
  }
}

// --- the sender ---

// One per viewer session. Nothing goes out until start() (called once the viewer has signed in).
export class MediaSender {
  constructor({ video, audio, quality = DEFAULT_QUALITY, log = null, onKeyframe = () => {}, onBitrate = () => {},
    now = () => Date.now() }) {
    this.video = video;   // werift RTCRtpSender (or anything with sendRtp, ssrc and the feedback events)
    this.audio = audio;
    this.log = log;
    this.onKeyframe = onKeyframe;
    this.now = now;
    this.enabled = false;
    this.waitingForKeyframe = true;
    this.lastKeyframeAsk = -Infinity;
    this.quality = QUALITY[quality] ? quality : DEFAULT_QUALITY;
    this.recent = [];   // [time, bytes] of video packets sent in the last second
    this.recentBytes = 0;
    this.bitrate = new BitrateController({
      preset: QUALITY[this.quality], now, onTarget: kbps => onBitrate(kbps), sentKbps: () => this.sentKbps(),
    });
    this.pacer = new Pacer({
      rateKbps: () => this.bitrate.target,
      send: (p, f) => this._sendVideoPacket(p, f),
      onOverflow: (freshKeyframe) => {
        if (freshKeyframe) return;
        this.waitingForKeyframe = true;
        this.askKeyframe('queue overflow');
      },
    });
    this.vclock = new VideoClock();
    this.aclock = new AudioClock();
    this.vseq = randomU16();
    this.aseq = randomU16();
    this.counters = { since: now(), bytes: 0, frames: 0 };
    this.totals = { videoPackets: 0, videoFrames: 0, audioPackets: 0, keyframes: 0, plis: 0 };
    this.subs = [];
    if (video?.onPictureLossIndication) {
      this.subs.push(video.onPictureLossIndication.subscribe(() => {
        this.totals.plis++;
        this.askKeyframe('browser asked (PLI)');
      }));
    }
    if (video?.onRtcp) this.subs.push(video.onRtcp.subscribe(p => this._onRtcp(p)));
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.waitingForKeyframe = true;
    this.counters = { since: this.now(), bytes: 0, frames: 0 };
    this.askKeyframe('session started');
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.quality = name;
    this.bitrate.setPreset(QUALITY[name]);
  }

  // Throttled: the browser may send several PLIs for one loss, and the encoder only needs one keyframe.
  askKeyframe(why) {
    const t = this.now();
    if (t - this.lastKeyframeAsk < KEYFRAME_MIN_GAP_MS) return false;
    this.lastKeyframeAsk = t;
    this.log?.debug(`keyframe: ${why}`);
    this.onKeyframe();
    return true;
  }

  pushVideo({ keyframe, ptsUs, data }) {
    if (!this.enabled) return;
    if (this.waitingForKeyframe) {
      // Frames before the first keyframe (or after a drop) can't be decoded; skip them and ask again.
      if (!keyframe) { this.askKeyframe('waiting for a keyframe'); return; }
      this.waitingForKeyframe = false;
    }
    const ts = this.vclock.ts(ptsUs);
    const packets = packetizeAccessUnit(splitAnnexB(data), { mtu: RTP_MTU });
    if (!packets.length) return;
    let bytes = 0;
    for (const p of packets) bytes += p.payload.length;
    if (keyframe) this.totals.keyframes++;
    this.pacer.push({ packets, bytes, keyframe, ts });
  }

  // werift's sender fills in the negotiated payload type and its own SSRC (and the header extensions), so the
  // payloadType and ssrc given here are only placeholders. Sequence numbers and timestamps are ours.
  _sendVideoPacket(p, f) {
    this.vseq = (this.vseq + 1) & 0xffff;
    const header = new RtpHeader({ payloadType: 96, sequenceNumber: this.vseq, timestamp: f.ts, marker: p.marker, ssrc: 0 });
    this.counters.bytes += p.payload.length;
    this.recent.push([this.now(), p.payload.length]);
    this.recentBytes += p.payload.length;
    this.totals.videoPackets++;
    if (p.marker) { this.counters.frames++; this.totals.videoFrames++; }
    this.video.sendRtp(new RtpPacket(header, p.payload)).catch?.(() => {});
  }

  pushAudio({ ptsUs, data }) {
    if (!this.enabled || !this.audio) return;
    const { ts, marker } = this.aclock.next(ptsUs);
    this.aseq = (this.aseq + 1) & 0xffff;
    const header = new RtpHeader({ payloadType: 111, sequenceNumber: this.aseq, timestamp: ts, marker, ssrc: 0 });
    this.totals.audioPackets++;
    this.audio.sendRtp(new RtpPacket(header, Buffer.from(data))).catch?.(() => {});
  }

  _onRtcp(p) {
    try {
      if (p.type === RtcpRrPacket.type || p.type === RtcpSrPacket.type) {
        for (const r of p.reports ?? []) {
          if (r.ssrc !== this.video.ssrc) continue;
          this.bitrate.onReport({ fractionLost: r.fractionLost / 256, rtt: this.video.rtt });
        }
      } else if (p.type === RtcpPayloadSpecificFeedback.type && p.feedback?.count === REMB_FEEDBACK_COUNT) {
        this.bitrate.onRemb(Number(p.feedback.bitrate));
      }
    } catch (e) {
      this.log?.debug('rtcp:', e.message);
    }
  }

  // Video actually sent over the last second, in kbit/s (null until sending has started).
  sentKbps() {
    if (!this.enabled) return null;
    const cutoff = this.now() - 1000;
    let i = 0;
    while (i < this.recent.length && this.recent[i][0] < cutoff) this.recentBytes -= this.recent[i++][1];
    if (i) this.recent.splice(0, i);
    return this.recentBytes * 8 / 1000;
  }

  // What the status message shows: measured send rate and frame rate since the last call, target and link quality.
  sample() {
    const t = this.now();
    const secs = Math.max(0.001, (t - this.counters.since) / 1000);
    const out = {
      kbps: Math.round(this.counters.bytes * 8 / secs / 1000),
      fps: Math.round(this.counters.frames / secs),
      target: this.bitrate.target,
      link: this.bitrate.link,
    };
    this.counters = { since: t, bytes: 0, frames: 0 };
    return out;
  }

  stop() {
    this.enabled = false;
    this.pacer.stop();
    for (const s of this.subs) s.unSubscribe?.();
    this.subs = [];
  }
}

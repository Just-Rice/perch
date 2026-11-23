// Connection numbers for the stats panel and the link-quality dot, worked out from RTCPeerConnection.getStats().
// Pure functions: they take the plain stats objects, so tests can feed them made-up reports.
import { routeOf, ROUTE_WORDS } from '../shared/route.js';

// Picks the few numbers Roost shows out of a stats report (anything iterable of stats objects, or a Map).
export function readStats(report) {
  const snap = { t: 0, video: null, audio: null, rttMs: null };
  for (const s of (report.values ? report.values() : report)) {
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      snap.t = s.timestamp ?? snap.t;
      snap.video = {
        bytes: s.bytesReceived ?? 0,
        packets: s.packetsReceived ?? 0,
        lost: s.packetsLost ?? 0,
        framesDecoded: s.framesDecoded ?? 0,
        fps: s.framesPerSecond ?? null,
        width: s.frameWidth ?? null,
        height: s.frameHeight ?? null,
        decoder: s.decoderImplementation ?? null,
        freezes: s.freezeCount ?? 0,
      };
    } else if (s.type === 'inbound-rtp' && s.kind === 'audio') {
      snap.audio = { bytes: s.bytesReceived ?? 0, packets: s.packetsReceived ?? 0, lost: s.packetsLost ?? 0 };
    } else if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && s.currentRoundTripTime != null) {
      snap.rttMs = s.currentRoundTripTime * 1000;
    }
  }
  return snap;
}

// Which way the connection runs (shared/route.js), from the candidate pair the browser chose: 'lan', 'internet',
// 'turn', or null before it has chosen. (A session over the relay Worker has no such report: the caller knows that.)
export function selectedRoute(report) {
  const all = [...(report.values ? report.values() : report)];
  const byId = new Map(all.map(s => [s.id, s]));
  const transport = all.find(s => s.type === 'transport' && s.selectedCandidatePairId);
  const pair = (transport && byId.get(transport.selectedCandidatePairId))
    ?? all.find(s => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
  if (!pair) return null;
  const local = byId.get(pair.localCandidateId), remote = byId.get(pair.remoteCandidateId);
  if (!local || !remote) return null;
  return routeOf(local.candidateType, remote.candidateType, remote.address ?? remote.ip);
}

// What changed between two snapshots: frames per second, picture size, video bitrate and packet loss in that time.
export function summarize(prev, cur) {
  const v = cur.video;
  const out = { fps: null, width: null, height: null, kbps: null, lossPct: null, rttMs: cur.rttMs, framesDecoded: 0 };
  if (!v) return out;
  out.width = v.width;
  out.height = v.height;
  out.framesDecoded = v.framesDecoded;
  out.fps = v.fps;
  const p = prev?.video;
  const dt = cur.t - (prev?.t ?? 0);
  if (p && dt > 0) {
    out.kbps = Math.max(0, Math.round(((v.bytes - p.bytes) * 8) / dt)); // bytes·8 per millisecond = kbit/s
    if (out.fps == null) out.fps = Math.max(0, Math.round(((v.framesDecoded - p.framesDecoded) * 1000) / dt));
    const lost = Math.max(0, v.lost - p.lost);
    const got = Math.max(0, v.packets - p.packets);
    out.lossPct = lost + got > 0 ? Math.round((lost / (lost + got)) * 1000) / 10 : 0;
  }
  return out;
}

// good / fair / poor, from what this browser measures and what the PC reports (`status.link`).
export function linkQuality({ rttMs = null, lossPct = null, macSaysSlow = false } = {}) {
  if ((lossPct != null && lossPct > 8) || (rttMs != null && rttMs > 400)) return 'poor';
  if (macSaysSlow || (lossPct != null && lossPct > 2) || (rttMs != null && rttMs > 150)) return 'fair';
  return 'good';
}

export const QUALITY_WORDS = { good: 'Good connection', fair: 'Slow connection', poor: 'Poor connection' };

// Lines for the stats panel, in plain words.
export function statsLines(sum, { pingMs = null, decoder = null, route = null } = {}) {
  const lines = [];
  const fmt = (v, unit) => (v == null ? '–' : `${v}${unit}`);
  lines.push(['Route', ROUTE_WORDS[route] ?? '–']);
  lines.push(['Picture', sum.width && sum.height ? `${sum.width} × ${sum.height}` : '–']);
  lines.push(['Frames a second', fmt(sum.fps == null ? null : Math.round(sum.fps), '')]);
  lines.push(['Video data', sum.kbps == null ? '–' : sum.kbps >= 1000 ? `${(sum.kbps / 1000).toFixed(1)} Mbit/s` : `${sum.kbps} kbit/s`]);
  lines.push(['Lost packets', fmt(sum.lossPct, '%')]);
  lines.push(['Round trip', fmt(pingMs == null ? (sum.rttMs == null ? null : Math.round(sum.rttMs)) : Math.round(pingMs), ' ms')]);
  if (decoder) lines.push(['Decoder', decoder]);
  return lines;
}

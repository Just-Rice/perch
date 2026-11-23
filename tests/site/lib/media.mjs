// Test media for the fake Mac: a short H.264 clip and an Opus tone, made once with ffmpeg and cached in the
// git-ignored tests/e2e/out/site/fixtures/, plus what is needed to send them over RTP:
//   - H.264 Annex-B → access units → RFC 6184 RTP payloads (single NAL, STAP-A, FU-A), ported from the spike in
//     .reference/webrtc-media/lib/h264.js;
//   - Ogg → raw Opus packets (RFC 7845), ported from .reference/webrtc-media/lib/ogg.js.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(HERE, '../../e2e/out/site/fixtures');

// --- making the files ---

// 1440×900 like a 16:10 Mac screen, 30 fps, a keyframe every second with SPS/PPS before each (as the Mac sends).
function makeVideo(file, { width = 1440, height = 900, seconds = 4 } = {}) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30`,
    '-t', String(seconds), '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '4.0', '-pix_fmt', 'yuv420p',
    '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-x264-params', 'repeat-headers=1', '-b:v', '1500k',
    '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', file + '.part']);
  renameSync(file + '.part', file);
}

// 20 ms Opus packets of a quiet 440 Hz tone, 48 kHz stereo (what the Mac's AudioToolbox encoder makes).
function makeAudio(file, { seconds = 4 } = {}) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-af', 'volume=0.2', '-t', String(seconds), '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', '-frame_duration', '20',
    '-f', 'ogg', file + '.part']);
  renameSync(file + '.part', file);
}

// Resolves to {aus: [{nals, keyframe}], opus: [Buffer]}. Throws a clear error when ffmpeg is missing.
export function loadTestMedia(dir = FIXTURE_DIR) {
  mkdirSync(dir, { recursive: true });
  const video = path.join(dir, 'clip-1440x900.h264');
  const audio = path.join(dir, 'tone.ogg');
  try {
    if (!existsSync(video)) makeVideo(video);
    if (!existsSync(audio)) makeAudio(audio);
  } catch (e) {
    throw new Error(`could not make the test media with ffmpeg (brew install ffmpeg): ${e.message}`);
  }
  const aus = groupAccessUnits(splitAnnexB(readFileSync(video)));
  const opus = oggOpusPackets(readFileSync(audio));
  if (!aus.length || !aus[0].keyframe) throw new Error('test video does not start with a keyframe');
  return { aus, opus };
}

// --- H.264 ---

const NAL_TYPE = nal => nal[0] & 0x1f;
const IDR = 5, SEI = 6, SPS = 7, PPS = 8, AUD = 9, STAP_A = 24, FU_A = 28;

export function splitAnnexB(buf) {
  const nals = [];
  let i = 0, start = -1;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && buf[end - 1] === 0) end--; // the extra zero of a 4-byte start code
        if (end > start) nals.push(buf.subarray(start, end));
      }
      i += 3;
      start = i;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < buf.length) nals.push(buf.subarray(start));
  return nals;
}

// A new frame starts at an AUD, at SPS/PPS/SEI after picture data, or at a slice whose first_mb_in_slice is 0.
export function groupAccessUnits(nals) {
  const aus = [];
  let cur = { nals: [], keyframe: false }, sawVcl = false;
  const flush = () => { if (cur.nals.length) aus.push(cur); cur = { nals: [], keyframe: false }; sawVcl = false; };
  for (const nal of nals) {
    const t = NAL_TYPE(nal);
    if (t === AUD) { flush(); continue; }
    if (sawVcl && (t === SPS || t === PPS || t === SEI)) flush();
    if (t >= 1 && t <= 5) {
      if (sawVcl && (nal[1] & 0x80)) flush();
      sawVcl = true;
      if (t === IDR) cur.keyframe = true;
    }
    cur.nals.push(nal);
  }
  flush();
  return aus;
}

// One access unit → RTP payloads with the marker on the last one.
export function packetizeAccessUnit(nals, mtu = 1200) {
  const out = [];
  const list = nals.filter(n => n.length && NAL_TYPE(n) !== AUD);
  for (let i = 0; i < list.length;) {
    const nal = list[i];
    if (nal.length > mtu) {
      const indicator = (nal[0] & 0xe0) | FU_A, type = nal[0] & 0x1f;
      for (let off = 1, first = true; off < nal.length; first = false) {
        const len = Math.min(mtu - 2, nal.length - off);
        const last = off + len >= nal.length;
        const p = Buffer.allocUnsafe(2 + len);
        p[0] = indicator;
        p[1] = (first ? 0x80 : 0) | (last ? 0x40 : 0) | type;
        Buffer.from(nal.buffer, nal.byteOffset, nal.length).copy(p, 2, off, off + len);
        out.push({ payload: p, marker: false });
        off += len;
      }
      i++;
      continue;
    }
    // Small NALs in a row (SPS, PPS, SEI) share one STAP-A packet.
    let size = 3 + nal.length, j = i + 1;
    while (j < list.length && list[j].length <= mtu && size + 2 + list[j].length <= mtu) size += 2 + list[j++].length;
    if (j - i >= 2) {
      const p = Buffer.allocUnsafe(size);
      let nri = 0, f = 0;
      for (let k = i; k < j; k++) { nri = Math.max(nri, list[k][0] & 0x60); f |= list[k][0] & 0x80; }
      p[0] = f | nri | STAP_A;
      let o = 1;
      for (let k = i; k < j; k++) { p.writeUInt16BE(list[k].length, o); o += 2; Buffer.from(list[k]).copy(p, o); o += list[k].length; }
      out.push({ payload: p, marker: false });
      i = j;
      continue;
    }
    out.push({ payload: Buffer.from(nal), marker: false });
    i++;
  }
  if (out.length) out[out.length - 1].marker = true;
  return out;
}

// --- Opus in Ogg ---

export function oggOpusPackets(buf) {
  const packets = [];
  let partial = [];
  for (let o = 0; o + 27 <= buf.length;) {
    if (buf.toString('latin1', o, o + 4) !== 'OggS') throw new Error(`bad Ogg page at ${o}`);
    const nSegs = buf[o + 26];
    const lacing = buf.subarray(o + 27, o + 27 + nSegs);
    const bodyStart = o + 27 + nSegs;
    let off = 0, segStart = 0;
    for (const l of lacing) {
      off += l;
      if (l < 255) {
        partial.push(buf.subarray(bodyStart + segStart, bodyStart + off));
        packets.push(Buffer.concat(partial));
        partial = [];
        segStart = off;
      }
    }
    if (segStart < off) partial.push(buf.subarray(bodyStart + segStart, bodyStart + off));
    o = bodyStart + off;
  }
  return packets.filter(p => !['OpusHead', 'OpusTags'].includes(p.toString('latin1', 0, 8)));
}

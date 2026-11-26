// Makes the small media files the tests play through the host (test/fixtures/). Needs ffmpeg with libx264 and
// libopus. Run from host/node:  node scripts/make-fixtures.mjs
//
// clip.h264  3 s of 640x360 test pattern at 30 fps, Constrained Baseline H.264, Annex-B, no B-frames, an IDR every
//            second with SPS/PPS repeated before each one — the same shape the Mac app's encoder produces.
// clip.opusl 3 s of a 440 Hz tone as 20 ms Opus packets (48 kHz stereo), each stored as [u16 BE length][packet].
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

export const VIDEO_ARGS = [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3',
  '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p',
  '-bf', '0', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
  '-x264-params', 'repeat-headers=1', '-b:v', '600k', '-maxrate', '700k', '-bufsize', '700k',
  '-bsf:v', 'h264_mp4toannexb', '-f', 'h264',
];
export const AUDIO_ARGS = [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-ac', '2',
  '-c:a', 'libopus', '-b:a', '64k', '-frame_duration', '20', '-application', 'lowdelay', '-f', 'ogg',
];

// Ogg pages → logical packets (RFC 3533), dropping the OpusHead and OpusTags header packets (RFC 7845).
export function opusPacketsFromOgg(buf) {
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

export function encodeLengthPrefixed(packets) {
  return Buffer.concat(packets.flatMap(p => {
    const h = Buffer.alloc(2);
    h.writeUInt16BE(p.length);
    return [h, p];
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tmp = mkdtempSync(join(tmpdir(), 'perch-fixtures-'));
  try {
    execFileSync('ffmpeg', [...VIDEO_ARGS, join(OUT, 'clip.h264')], { stdio: 'inherit' });
    execFileSync('ffmpeg', [...AUDIO_ARGS, join(tmp, 'clip.ogg')], { stdio: 'inherit' });
    const packets = opusPacketsFromOgg(readFileSync(join(tmp, 'clip.ogg')));
    writeFileSync(join(OUT, 'clip.opusl'), encodeLengthPrefixed(packets));
    console.log(`clip.h264 ${statSync(join(OUT, 'clip.h264')).size} bytes; clip.opusl ${packets.length} packets, ` +
      `${statSync(join(OUT, 'clip.opusl')).size} bytes`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

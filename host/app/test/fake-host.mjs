#!/usr/bin/env node
// A stand-in for Perch's Node host, for testing Perch.app on its own. The app starts this script exactly as it starts
// the real host, and the script drives the app through the IPC protocol (docs/PROTOCOL.md, "App ⇄ host process"):
// it checks HELLO, runs capture and checks the video and audio that come back (and has ffprobe/ffmpeg decode them),
// sends input and checks the echoes, and tries every other command. It speaks the protocol with its own few lines of
// framing code rather than the host's, so a mistake on either side can't hide itself.
//
//   cd host/app && swift build -c release
//   .build/release/Perch --synthetic --no-ui --echo-input --exit-with-host --node "$(command -v node)" --host test/fake-host.mjs
//
// PASS/FAIL lines go to stderr, which the app copies into its log and onto its own stderr. With --exit-with-host the
// app exits with this script's verdict (0 when everything passed). test/run.sh runs every mode below.
//
// Environment (the app passes its own environment through):
//   PERCH_FAKE_MODE   synthetic (default): first checks the app survives this script crashing and then sending a
//                       broken frame (it must restart the host each time, with backoff), then runs everything
//                     quick: everything, without the restart checks
//                     real: a short run against the real screen and sound (run the app without --synthetic); the
//                       video and audio it captures are deleted at the end, since they show the real screen
//                     bundle: run from inside a built Perch.app; checks the bundled paths, ends with `uninstall`,
//                       which a test run must refuse (it quits without touching anything)
//                     ui: run with the menu bar item (no --no-ui); checks the icon follows the session
//   PERCH_FAKE_REPORT a file to write the PASS/FAIL lines to as well
//   PERCH_FAKE_KEEP=1 keep the captured files of a synthetic run and say where they are
//   PERCH_HOME        when set, the app logs to $PERCH_HOME/app.log, which the checks read
//
// Nothing may ever be written to stdout except frames: stdout is the pipe to the app.
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODE = process.env.PERCH_FAKE_MODE || 'synthetic';
const KEEP = process.env.PERCH_FAKE_KEEP === '1' && MODE !== 'real';
const APP_LOG = process.env.PERCH_HOME ? path.join(process.env.PERCH_HOME, 'app.log') : null;
const T = { HELLO: 0x01, VIDEO: 0x02, AUDIO: 0x03, EVENT: 0x04, COMMAND: 0x10, INPUT: 0x11 };
const MARKER = `fake-host marker ${process.pid}-${Math.random().toString(36).slice(2)}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => process.stderr.write(`fake-host: ${msg}\n`);

// ---- results ----

const results = [];
/** `detail` explains a failure; on a pass it is shown too when it is short (a measurement such as "31 ms"). */
function check(name, ok, detail = '') {
  detail = String(detail);
  const shown = ok ? (detail && detail.length <= 60 ? ` (${detail})` : '') : (detail ? `: ${detail}` : '');
  results.push({ name, ok: !!ok, line: `${ok ? 'PASS' : 'FAIL'} ${name}${shown}` });
  log(results.at(-1).line);
  return !!ok;
}
async function section(name, fn) {
  try { await fn(); } catch (e) { check(`${name} ran to the end`, false, e.message); }
}

// ---- the pipe ----

function frame(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, payload]);
}
const sendRaw = buf => process.stdout.write(buf);
const command = (c, fields = {}) => sendRaw(frame(T.COMMAND, Buffer.from(JSON.stringify({ c, ...fields }))));
const sendInput = msg => sendRaw(frame(T.INPUT, Buffer.from(JSON.stringify(msg))));

const got = { hello: null, helloAt: 0, helloIndex: -1, frames: 0, events: [], video: [], audio: [], bad: [], ended: false };
const waiters = new Set();
let inbuf = Buffer.alloc(0);
let onEnd = null;

process.stdin.on('data', chunk => {
  inbuf = inbuf.length ? Buffer.concat([inbuf, chunk]) : chunk;
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32BE(0);
    if (len < 1 || len > 64 << 20) { got.bad.push(`frame length ${len}`); inbuf = Buffer.alloc(0); break; }
    if (inbuf.length < 4 + len) break;
    receive(inbuf[4], Buffer.from(inbuf.subarray(5, 4 + len)));
    inbuf = inbuf.subarray(4 + len);
  }
  poke();
});
process.stdin.on('end', () => { got.ended = true; poke(); onEnd?.(); });

function receive(type, p) {
  const at = performance.now();
  const index = got.frames++;
  try {
    switch (type) {
      case T.HELLO: got.hello = JSON.parse(p); got.helloAt = at; got.helloIndex = index; break;
      case T.EVENT: got.events.push({ at, ev: JSON.parse(p) }); break;
      case T.VIDEO:
        if (p.length < 10) { got.bad.push(`VIDEO of ${p.length} bytes`); break; }
        got.video.push({ at, flags: p[0], key: (p[0] & 1) === 1, pts: Number(p.readBigUInt64BE(1)), data: p.subarray(9) });
        break;
      case T.AUDIO:
        if (p.length < 9) { got.bad.push(`AUDIO of ${p.length} bytes`); break; }
        got.audio.push({ at, pts: Number(p.readBigUInt64BE(0)), data: p.subarray(8) });
        break;
      default: got.bad.push(`frame type 0x${type.toString(16)}`);
    }
  } catch (e) {
    got.bad.push(`unreadable frame type ${type}: ${e.message}`);
  }
}

/** Resolves with pred()'s first truthy value, re-checked as frames arrive. */
function until(pred, ms, what) {
  return new Promise((resolve, reject) => {
    const v = pred();
    if (v) return resolve(v);
    const w = { pred, resolve };
    w.timer = setTimeout(() => { waiters.delete(w); reject(new Error(`timed out after ${ms} ms waiting for ${what}`)); }, ms);
    waiters.add(w);
  });
}
function poke() {
  for (const w of [...waiters]) {
    let v;
    try { v = w.pred(); } catch { v = undefined; }
    if (v) { clearTimeout(w.timer); waiters.delete(w); w.resolve(v); }
  }
}

/** The first event called `e` (matching `where`) after event index `since`. */
async function event(e, { since = 0, where = () => true, ms = 3000 } = {}) {
  const hit = await until(() => got.events.slice(since).find(x => x.ev.e === e && where(x.ev)), ms, `a ${e} event`);
  return hit.ev;
}
const logEvents = since => got.events.slice(since).filter(x => x.ev.e === 'log').map(x => x.ev);

/** Sends a command and waits until the app has run it: commands run in order on the app's main thread, so once the
 *  `permissions` event asked for afterwards arrives, everything sent before it has been handled. */
async function settled() {
  const since = got.events.length;
  command('permissions');
  await event('permissions', { since });
}

// ---- H.264 ----

function nalUnits(buf) {
  const units = [];
  let i = 0, start = -1;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) units.push(buf.subarray(start, buf[i - 1] === 0 && i - 1 > start ? i - 1 : i));
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < buf.length) units.push(buf.subarray(start));
  return units;
}
const nalTypes = buf => nalUnits(buf).map(u => u[0] & 0x1f);

/** Profile, level and picture size from a Baseline-family SPS (ITU-T H.264 §7.3.2.1.1). */
function parseSps(nal) {
  const rbsp = [];
  let zeros = 0;
  for (let i = 1; i < nal.length; i++) {
    if (zeros >= 2 && nal[i] === 3) { zeros = 0; continue; } // emulation prevention byte
    rbsp.push(nal[i]);
    zeros = nal[i] === 0 ? zeros + 1 : 0;
  }
  let bit = 0;
  const u = n => { let v = 0; for (let k = 0; k < n; k++, bit++) v = v * 2 + ((rbsp[bit >> 3] >> (7 - (bit & 7))) & 1); return v; };
  const ue = () => { let z = 0; while (u(1) === 0) { if (++z > 31) throw new Error('bad exp-Golomb code'); } return 2 ** z - 1 + u(z); };
  const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };
  const profile = u(8), constraints = u(8), level = u(8);
  ue(); // seq_parameter_set_id
  if (![66, 77, 88].includes(profile)) throw new Error(`profile ${profile} is not Baseline/Main/Extended`);
  ue(); // log2_max_frame_num_minus4
  const pocType = ue();
  if (pocType === 0) ue();
  else if (pocType === 1) { u(1); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
  ue(); u(1); // max_num_ref_frames, gaps_in_frame_num_value_allowed_flag
  const wMbs = ue() + 1, hUnits = ue() + 1;
  const frameMbsOnly = u(1);
  if (!frameMbsOnly) u(1);
  u(1); // direct_8x8_inference_flag
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (u(1)) { cl = ue(); cr = ue(); ct = ue(); cb = ue(); }
  // 4:2:0 crop units: 2 across, 2 × (2 − frame_mbs_only_flag) down.
  return { profile, constraints, level, width: wMbs * 16 - 2 * (cl + cr),
    height: (2 - frameMbsOnly) * hUnits * 16 - 2 * (2 - frameMbsOnly) * (ct + cb) };
}

/** Checks one segment of video frames (all the same size, starting at a keyframe). */
function checkVideo(label, frames, { width, height, minFps, seconds }) {
  if (!check(`${label}: frames arrived`, frames.length > 0, `${frames.length} frames`)) return;
  const first = frames[0];
  const types = nalTypes(first.data);
  check(`${label}: first frame is a keyframe, Annex-B, SPS then PPS then IDR`,
    first.key && first.data.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1])) && types.slice(0, 3).join() === '7,8,5', `key ${first.key}, NAL types ${types}`);
  const sps = parseSps(nalUnits(first.data)[0]);
  check(`${label}: SPS is Constrained Baseline at ${width}x${height}`,
    sps.profile === 66 && (sps.constraints & 0x40) !== 0 && sps.width === width && sps.height === height,
    `profile ${sps.profile}, constraints 0x${sps.constraints.toString(16)}, ${sps.width}x${sps.height}`);
  const badKeys = frames.filter(f => f.key).filter(f => { const t = nalTypes(f.data); return !(t[0] === 7 && t[1] === 8 && t.includes(5)); });
  check(`${label}: every keyframe starts with SPS and PPS`, badKeys.length === 0, badKeys.length ? `${badKeys.length} without` : `${frames.filter(f => f.key).length} keyframes`);
  const deltas = frames.filter(f => !f.key);
  const badDeltas = deltas.filter(f => { const t = nalTypes(f.data); return t.includes(7) || t.includes(8) || t.includes(5) || !t.includes(1); });
  check(`${label}: delta frames are plain slices (no SPS/PPS/IDR)`, deltas.length > 0 && badDeltas.length === 0,
    badDeltas.length ? `${badDeltas.length} of ${deltas.length} bad (${badDeltas.slice(0, 2).map(f => nalTypes(f.data)).join(' | ')})` : `${deltas.length} deltas`);
  check(`${label}: flags use only bit 0`, frames.every(f => (f.flags & ~1) === 0));
  const backwards = frames.findIndex((f, i) => i > 0 && f.pts <= frames[i - 1].pts);
  check(`${label}: pts strictly increasing`, backwards < 0, backwards < 0 ? '' : `not at frame ${backwards}`);
  if (seconds) {
    const fps = frames.length / seconds;
    check(`${label}: about ${minFps}+ frames a second`, fps >= minFps, `${fps.toFixed(1)} fps`);
  }
}

function kbpsOver(frames, from, to) {
  const bytes = frames.filter(f => f.at >= from && f.at < to).reduce((n, f) => n + f.data.length, 0);
  return bytes * 8 / (to - from); // bits per ms = kbit/s
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { maxBuffer: 256 << 20, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return r;
}

/** ffprobe's view of an Annex-B file, plus whether ffmpeg decodes all of it without a single error. */
function probeH264(file) {
  const r = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
    'stream=codec_name,profile,width,height,pix_fmt,nb_read_frames', '-of', 'json', file]);
  const s = JSON.parse(r.stdout.toString()).streams?.[0] ?? {};
  const d = run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  return { ...s, frames: Number(s.nb_read_frames), decodeErrors: d.stderr.toString().trim() };
}

/** Reads the frame counter the synthetic pattern draws along the top 16 rows (32 blocks, bit 0 on the left). */
function readCounters(file, width) {
  const r = run('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'crop=iw:16:0:0,format=gray', '-f', 'rawvideo', '-']);
  const rows = r.stdout, per = width * 16, block = Math.max(Math.floor(width / 32), 1), out = [];
  for (let o = 0; o + per <= rows.length; o += per) {
    let v = 0;
    for (let b = 0; b < 32; b++) if (rows[o + 8 * width + b * block + (block >> 1)] > 128) v += 2 ** b;
    out.push(v);
  }
  return out;
}

// ---- Opus ----

/** RFC 6716 §3.1: the TOC byte's configuration, stereo flag and frame-count code. */
function toc(packet) {
  const b = packet[0], config = b >> 3;
  const frameMs = config < 12 ? [10, 20, 40, 60][config & 3] : config < 16 ? [10, 20][config & 1] : [2.5, 5, 10, 20][config & 3];
  return { config, stereo: (b & 4) !== 0, code: b & 3, frameMs };
}

const OGG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggPage(packets, { granule, serial, seq, flags }) {
  const lacing = [];
  for (const p of packets) { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); }
  const head = Buffer.alloc(27 + lacing.length);
  head.write('OggS', 0, 'latin1');
  head[5] = flags;
  head.writeBigUInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial, 14);
  head.writeUInt32LE(seq, 18);
  head[26] = lacing.length;
  Buffer.from(lacing).copy(head, 27);
  const page = Buffer.concat([head, ...packets]);
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  page.writeUInt32LE(crc, 22);
  return page;
}

/** Raw Opus packets → an Ogg Opus file (RFC 7845) that ffmpeg can decode. */
function oggOpus(packets) {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1; head[9] = 2; head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12);
  const vendor = Buffer.from('perch fake host');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'latin1'); tags.writeUInt32LE(vendor.length, 8); vendor.copy(tags, 12);
  const serial = 0x50524348, pages = [oggPage([head], { granule: 0, serial, seq: 0, flags: 2 }), oggPage([tags], { granule: 0, serial, seq: 1, flags: 0 })];
  let granule = 0;
  for (let i = 0; i < packets.length; i += 50) {
    const chunk = packets.slice(i, i + 50);
    granule += chunk.length * 960;
    pages.push(oggPage(chunk, { granule, serial, seq: pages.length, flags: i + 50 >= packets.length ? 4 : 0 }));
  }
  return Buffer.concat(pages);
}

/** Decodes an Ogg Opus file with ffmpeg and measures the left channel's pitch and loudness (skipping 100 ms). */
function measureTone(file) {
  const r = run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', '48000', '-']);
  const pcm = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 2);
  const left = [];
  for (let i = 9600; i < pcm.length; i += 2) left.push(pcm[i]);
  let crossings = 0, sq = 0;
  for (let i = 1; i < left.length; i++) if ((left[i - 1] < 0) !== (left[i] < 0)) crossings++;
  for (const v of left) sq += v * v;
  return { seconds: pcm.length / 2 / 48000, hz: crossings / 2 / (left.length / 48000), rms: Math.sqrt(sq / Math.max(left.length, 1)),
    errors: r.stderr.toString().trim() };
}

function checkAudio(label, packets, seconds) {
  if (!check(`${label}: Opus packets arrived`, packets.length > 0, `${packets.length} packets`)) return;
  const rate = packets.length / seconds;
  check(`${label}: about 50 packets a second (one per 20 ms)`, rate > 42 && rate < 58, `${rate.toFixed(1)} a second`);
  const tocs = packets.map(p => toc(p.data));
  const odd = tocs.filter(t => !(t.stereo && t.code === 0 && t.frameMs === 20));
  check(`${label}: every packet is one 20 ms stereo frame`, odd.length === 0, odd.length ? `${odd.length} odd, e.g. ${JSON.stringify(odd[0])}` : `TOC config ${tocs[0].config}`);
  const sizes = packets.map(p => p.data.length);
  check(`${label}: packet sizes sane`, sizes.every(n => n >= 3 && n <= 1500), `${Math.min(...sizes)}–${Math.max(...sizes)} bytes`);
  const steps = packets.slice(1).map((p, i) => p.pts - packets[i].pts);
  const offStep = steps.filter(s => s < 19000 || s > 21000);
  check(`${label}: pts advance 20 ms a packet`, steps.every(s => s > 0) && offStep.length <= steps.length * 0.05,
    offStep.length ? `${offStep.length}/${steps.length} steps off, e.g. ${offStep.slice(0, 5)}` : '');
  const bps = sizes.reduce((a, b) => a + b, 0) * 8 / seconds;
  return bps;
}

// ---- the app's log ----

const appLog = () => (APP_LOG && existsSync(APP_LOG) ? readFileSync(APP_LOG, 'utf8') : '');

// ---- power assertions, as `pmset -g assertions` lists them for the app's process ----

function assertions() {
  const out = run('pmset', ['-g', 'assertions']).stdout.toString();
  return out.split('\n').filter(l => l.includes(`pid ${process.ppid}(`)).join('\n');
}

// ---- the runs ----

// Kept in this run's own PERCH_HOME: a file named only by the app's pid could be left over from an earlier run
// whose app had the same (reused) pid.
const STATE = path.join(process.env.PERCH_HOME || tmpdir(), `perch-fake-host-${process.ppid}.json`);
const readState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { runs: 0, results: [] }; } };
const writeState = s => writeFileSync(STATE, JSON.stringify(s));

async function helloChecks() {
  const h = await until(() => got.hello, 5000, 'HELLO');
  check('HELLO is the first frame', got.helloIndex === 0, got.helloIndex === 0 ? '' : `it was frame ${got.helloIndex}`);
  check('HELLO says app Perch, IPC 1, a version and macOS version',
    h.app === 'Perch' && h.ipc === 1 && /^\d+\.\d+\.\d+$/.test(h.version) && /^\d+\.\d+/.test(h.macos), JSON.stringify(h));
  check('PERCH_APP_VERSION matches HELLO', process.env.PERCH_APP_VERSION === h.version, `${process.env.PERCH_APP_VERSION} vs ${h.version}`);
  check('HELLO permissions are booleans', typeof h.permissions?.screen === 'boolean' && typeof h.permissions?.accessibility === 'boolean');
  const ds = Array.isArray(h.displays) ? h.displays : [];
  check('HELLO lists displays {id, name, width, height, main}, one main',
    ds.length > 0 && ds.every(d => Number.isInteger(d.id) && typeof d.name === 'string' && d.width > 0 && d.height > 0 && typeof d.main === 'boolean')
      && ds.filter(d => d.main).length === 1, JSON.stringify(ds));
  check('HELLO reports the login item {on, status}', typeof h.loginItem?.on === 'boolean' && typeof h.loginItem?.status === 'string', JSON.stringify(h.loginItem));
  const lock = await event('lock', { ms: 3000 });
  check('a lock event follows HELLO', typeof lock.locked === 'boolean');
  return h;
}

/** Run 1 of the synthetic mode: crash straight after HELLO. */
async function crashRun(state) {
  await until(() => got.hello, 5000, 'HELLO');
  writeState({ runs: 1, exitAt: Date.now(), results: [] });
  log('run 1: exiting with status 3 to check the app restarts its host');
  process.exit(3);
}

/** Run 2: send a broken frame; the app must stop this host (and then start another). */
async function garbageRun(state) {
  await until(() => got.hello, 5000, 'HELLO');
  const gap = Date.now() - state.exitAt;
  const res = [{ name: 'app restarted the host after it crashed (about 1 s later)', ok: gap >= 800 && gap < 4000, detail: `${gap} ms` }];
  let done = false;
  const stopped = how => {
    if (done) return;
    done = true;
    res.push({ name: `app stopped a host that sent a broken frame (${how})`, ok: true, detail: '' });
    writeState({ runs: 2, exitAt: Date.now(), results: res });
    process.exit(0);
  };
  process.on('SIGTERM', () => stopped('SIGTERM'));
  onEnd = () => stopped('closed its input');
  log('run 2: sending a zero-length frame');
  sendRaw(Buffer.from([0, 0, 0, 0]));
  await sleep(5000);
  res.push({ name: 'app stopped a host that sent a broken frame', ok: false, detail: 'still running after 5 s' });
  writeState({ runs: 2, exitAt: Date.now(), results: res });
  process.exit(0);
}

async function captureChecks(h) {
  const synthetic = h.synthetic === true;
  const tmp = mkdtempSync(path.join(tmpdir(), 'perch-fake-host-'));
  try {
    // 1. Start: 1280 wide, 30 fps, 2.5 Mbit/s, with sound. Sent the way the real host does when a viewer signs in:
    //    the session (which wakes the display and keeps it on) and the capture straight after it. On a locked Mac the
    //    display is often asleep at this point, and the app must wake it and wait rather than fail.
    let since = got.events.length;
    const vStart = got.video.length, aStart = got.audio.length;
    const t0 = performance.now();
    command('session', { active: true, viewer: 'Chrome on Pixel', route: 'passkey' });
    command('capture', { on: true, maxEdge: 1280, fps: 30, kbps: 2500, audio: true });
    const startHit = await until(() => got.events.slice(since).find(x => x.ev.e === 'capture-started' || x.ev.e === 'capture-error'),
      10000, 'capture-started');
    if (startHit.ev.e === 'capture-error') throw new Error(`capture-error ${startHit.ev.code}: ${startHit.ev.message}`);
    const started = startHit.ev;
    const woke = !synthetic && appLog().includes('isn\'t capturable yet');
    check(`capture started within ${woke ? '8 s (the display had to wake up first)' : '2 s'} of the command`,
      startHit.at - t0 < (woke ? 8000 : 2000), `${Math.round(startHit.at - t0)} ms`);
    const main = h.displays.find(d => d.main);
    if (synthetic) {
      check('capture-started: display 1 at 1280x720, 30 fps', started.display === 1 && started.width === 1280 && started.height === 720 && started.fps === 30, JSON.stringify(started));
    } else {
      const aspect = main.width / main.height, got_ = started.width / started.height;
      check('capture-started: the main display, at most 1280 wide, even sizes, its shape kept',
        started.display === main.id && Math.max(started.width, started.height) <= 1280 && started.width % 2 === 0 && started.height % 2 === 0
          && Math.abs(got_ - aspect) / aspect < 0.01 && started.fps === 30, JSON.stringify(started));
    }
    const firstFrameAt = (await until(() => got.video.length > vStart && got.video[vStart], 3000, 'the first video frame')).at;
    check('first video frame within 1 s of capture-started', firstFrameAt - startHit.at < 1000,
      `${Math.round(firstFrameAt - startHit.at)} ms; ${Math.round(firstFrameAt - t0)} ms after the command`);
    const W = started.width, H = started.height;
    await sleep(3000);
    const tA = performance.now();

    // 2. A keyframe on request.
    let mark = got.video.length;
    const tk = performance.now();
    command('keyframe');
    const kf = await until(() => got.video.slice(mark).find(f => f.key), 1500, 'a keyframe after the keyframe command');
    check('keyframe command: a keyframe with SPS/PPS follows quickly', nalTypes(kf.data).slice(0, 2).join() === '7,8' && kf.at - tk < 600,
      `${Math.round(kf.at - tk)} ms, types ${nalTypes(kf.data)}`);

    // 3. Bitrate down.
    const before = kbpsOver(got.video, tA - 2000, tA);
    command('bitrate', { kbps: 600 });
    await sleep(1000);
    const tb = performance.now();
    await sleep(2000);
    const after = kbpsOver(got.video, tb, performance.now());
    if (synthetic) {
      check('video bitrate near the 2500 kbit/s asked for', before > 1250 && before < 3750, `${Math.round(before)} kbit/s`);
      check('bitrate command: video drops to about 600 kbit/s', after > 150 && after < 900, `${Math.round(after)} kbit/s`);
    } else {
      check('video bitrate stays under the 2500 kbit/s asked for (a mostly still screen needs far less)', before < 3750, `${Math.round(before)} kbit/s`);
      check('bitrate command keeps video under 600 kbit/s', after < 900, `${Math.round(after)} kbit/s`);
    }
    const audio1 = got.audio.slice(aStart);
    const audioSeconds = (performance.now() - firstFrameAt) / 1000;

    // 4. Reconfigure: smaller, slower, no sound. A new encoder, so a new keyframe with a new SPS.
    let seg2Start = -1, seg2Started = null;
    if (synthetic) {
      since = got.events.length;
      mark = got.video.length;
      command('capture', { on: true, maxEdge: 640, fps: 15, kbps: 800, audio: false });
      seg2Started = await event('capture-started', { since, ms: 5000 });
      check('reconfigured capture-started: 640x360, 15 fps', seg2Started.width === 640 && seg2Started.height === 360 && seg2Started.fps === 15, JSON.stringify(seg2Started));
      const k2 = await until(() => got.video.slice(mark).find(f => f.key && parseSps(nalUnits(f.data)[0]).width === 640), 3000, 'a 640-wide keyframe');
      seg2Start = got.video.indexOf(k2);
      check('reconfigure: no old-size frame after the new keyframe', got.video.slice(seg2Start).every(f => !f.key || parseSps(nalUnits(f.data)[0]).width === 640));
      await sleep(500);
      const audioMark = got.audio.length;
      const t2 = performance.now();
      await sleep(1500);
      check('reconfigure without audio: no more audio packets', got.audio.length === audioMark, `${got.audio.length - audioMark} arrived`);
      const fps2 = got.video.filter(f => f.at >= t2).length / ((performance.now() - t2) / 1000);
      check('reconfigure: about 15 frames a second now', fps2 > 10 && fps2 < 17, `${fps2.toFixed(1)} fps`);

      // Same size again with another bitrate: the stream keeps going, says capture-started again, and makes a keyframe.
      since = got.events.length;
      mark = got.video.length;
      command('capture', { on: true, maxEdge: 640, fps: 15, kbps: 400, audio: false });
      const again = await event('capture-started', { since, ms: 2000 });
      const k3 = await until(() => got.video.slice(mark).find(f => f.key), 1500, 'a keyframe after the same-size capture');
      check('same-size capture: capture-started again and a keyframe', again.width === 640 && !!k3);
    }

    // 5. Stop.
    since = got.events.length;
    command('capture', { on: false });
    const stopped = await event('capture-stopped', { since, ms: 3000 });
    check('capture off: capture-stopped {reason: "requested"}', stopped.reason === 'requested', JSON.stringify(stopped));
    await sleep(300);
    const vEnd = got.video.length, aEnd = got.audio.length;
    await sleep(1200);
    check('capture off: no frames afterwards', got.video.length === vEnd && got.audio.length === aEnd,
      `${got.video.length - vEnd} video, ${got.audio.length - aEnd} audio`);

    // 6. Look at everything that came: the live checks, then ffprobe/ffmpeg on the files.
    const all = got.video.slice(vStart, vEnd);
    const seg1 = seg2Start < 0 ? all : got.video.slice(vStart, seg2Start);
    if (synthetic) {
      checkVideo('1280x720 video', seg1, { width: W, height: H });
      // Frame rate while the bitrate was still 2.5 Mbit/s (at 600 kbit/s rate control rightly drops frames).
      const fps = seg1.filter(f => f.at < tA).length / ((tA - firstFrameAt) / 1000);
      check('1280x720 video: close to 30 frames a second', fps >= 24 && fps <= 31, `${fps.toFixed(1)} fps`);
    } else {
      checkVideo('real screen video', seg1, { width: W, height: H });
      // A still screen sends almost nothing, so the app repeats the last picture about once a second.
      const longest = Math.max(...seg1.slice(1).map((f, i) => f.at - seg1[i].at));
      check('real screen: never more than ~1.5 s without a frame', longest < 1600, `${Math.round(longest)} ms gap`);
    }
    const f1 = path.join(tmp, `video-${W}x${H}.h264`);
    writeFileSync(f1, Buffer.concat(seg1.map(f => f.data)));
    const p1 = probeH264(f1);
    check(`ffprobe: ${W}x${H} H.264 Constrained Baseline, every frame readable`,
      p1.codec_name === 'h264' && p1.profile === 'Constrained Baseline' && p1.width === W && p1.height === H && p1.frames === seg1.length,
      JSON.stringify({ ...p1, sent: seg1.length }));
    check(`ffmpeg decodes the ${W}x${H} stream without errors`, p1.decodeErrors === '', p1.decodeErrors.slice(0, 300));
    if (synthetic) {
      const counters = readCounters(f1, W);
      const back = counters.findIndex((c, i) => i > 0 && c < counters[i - 1]);
      check('synthetic frame counter read back from the decoded pictures never goes backwards', counters.length === seg1.length && back < 0,
        back < 0 ? `${counters.length} pictures` : `${counters.length} decoded, went back at ${back}: ${counters.slice(Math.max(0, back - 2), back + 2)}`);
      const span = (seg1.at(-1).pts - seg1[0].pts) / 1e6 * 30, counted = counters.at(-1) - counters[0];
      check('frame counter and pts agree on how much time passed', Math.abs(span - counted) <= 3, `pts say ${span.toFixed(1)} frames, counter ${counted}`);
    }
    if (seg2Start >= 0) {
      const seg2 = got.video.slice(seg2Start, vEnd);
      checkVideo('640x360 video', seg2, { width: 640, height: 360 });
      const f2 = path.join(tmp, 'video-640x360.h264');
      writeFileSync(f2, Buffer.concat(seg2.map(f => f.data)));
      const p2 = probeH264(f2);
      check('ffprobe: 640x360 stream readable to the last frame', p2.width === 640 && p2.height === 360 && p2.frames === seg2.length && p2.decodeErrors === '',
        JSON.stringify({ ...p2, sent: seg2.length }));
      const c2 = readCounters(f2, 640);
      check('640x360 frame counter never goes backwards', c2.length === seg2.length && c2.every((c, i) => i === 0 || c >= c2[i - 1]), `${c2.length} pictures: ${c2.slice(0, 6)}…`);
    }

    // Sound: synthetic is a 440 Hz tone; the real Mac sends whatever it plays (often silence), so only the format is
    // checked there.
    const bps = checkAudio(synthetic ? 'test tone' : 'system audio', audio1, audioSeconds);
    if (synthetic && bps) check('Opus bitrate about 64 kbit/s', bps > 40000 && bps < 90000, `${Math.round(bps)} bit/s`);
    if (audio1.length && seg1.length) {
      check('audio and video timestamps share one clock', Math.abs(audio1[0].pts - seg1[0].pts) < 1_000_000,
        `first audio ${audio1[0].pts}, first video ${seg1[0].pts}`);
    }
    if (audio1.length) {
      const fo = path.join(tmp, 'audio.opus');
      writeFileSync(fo, oggOpus(audio1.map(p => p.data)));
      const tone = measureTone(fo);
      check('ffmpeg decodes the Opus packets', tone.errors === '' && Math.abs(tone.seconds - audio1.length * 0.02) < 0.1,
        `${tone.seconds.toFixed(2)} s from ${audio1.length} packets${tone.errors ? '; ' + tone.errors.slice(0, 200) : ''}`);
      if (synthetic) {
        check('the decoded sound is the 440 Hz test tone', Math.abs(tone.hz - 440) < 5 && Math.abs(tone.rms - 0.1414) < 0.04,
          `${tone.hz.toFixed(1)} Hz, rms ${tone.rms.toFixed(3)}`);
      }
    }
    if (KEEP) log(`kept the captured files in ${tmp}`);
  } finally {
    command('session', { active: false });
    if (!KEEP) rmSync(tmp, { recursive: true, force: true });
  }
}

const deepEqual = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}

/** Sends one input message and returns the events the app says it would have posted. */
async function echo(msg) {
  const since = got.events.length;
  sendInput(msg);
  const ev = await event('input-echo', { since, where: e => deepEqual(e.ev, msg), ms: 2000 });
  return ev.out;
}

// Quartz event flag bits, as the app reports them.
const SHIFT = 0x20000, CONTROL = 0x40000, COMMAND = 0x100000, NUMPAD = 0x200000, FN = 0x800000;

async function inputChecks(h) {
  // The pretend display in synthetic mode is 1920x1080 points at (0, 0); otherwise the main display (also at 0, 0).
  const main = h.synthetic ? { width: 1920, height: 1080 } : h.displays.find(d => d.main);
  const X = f => Math.min(f * main.width, main.width - 1), Y = f => Math.min(f * main.height, main.height - 1);
  const r2 = v => Math.round(v * 100) / 100;
  const expect = async (name, msg, want) => {
    const out = await echo(msg);
    check(`input: ${name}`, deepEqual(out, want), `got ${JSON.stringify(out)}, want ${JSON.stringify(want)}`);
  };
  await expect('pointer move maps onto the display', { t: 'm', x: 0.5, y: 0.25 }, [{ type: 'mouseMoved', x: r2(X(0.5)), y: r2(Y(0.25)), flags: 0 }]);
  await expect('left button down where the pointer is', { t: 'b', b: 0, d: true, x: 0.5, y: 0.25, n: 1 },
    [{ type: 'leftMouseDown', button: 0, x: r2(X(0.5)), y: r2(Y(0.25)), click: 1, flags: 0 }]);
  await expect('moving with the button held drags', { t: 'm', x: 0.75, y: 0.5 }, [{ type: 'leftMouseDragged', x: r2(X(0.75)), y: r2(Y(0.5)), flags: 0 }]);
  await expect('left button up', { t: 'b', b: 0, d: false, x: 0.75, y: 0.5, n: 1 },
    [{ type: 'leftMouseUp', button: 0, x: r2(X(0.75)), y: r2(Y(0.5)), click: 1, flags: 0 }]);
  await expect('a click somewhere else moves there first (double click)', { t: 'b', b: 0, d: true, x: 0.125, y: 0.2, n: 2 },
    [{ type: 'mouseMoved', x: r2(X(0.125)), y: r2(Y(0.2)), flags: 0 }, { type: 'leftMouseDown', button: 0, x: r2(X(0.125)), y: r2(Y(0.2)), click: 2, flags: 0 }]);
  await expect('double click up', { t: 'b', b: 0, d: false, x: 0.125, y: 0.2, n: 2 },
    [{ type: 'leftMouseUp', button: 0, x: r2(X(0.125)), y: r2(Y(0.2)), click: 2, flags: 0 }]);
  await expect('triple click', { t: 'b', b: 0, d: true, x: 0.125, y: 0.2, n: 3 },
    [{ type: 'leftMouseDown', button: 0, x: r2(X(0.125)), y: r2(Y(0.2)), click: 3, flags: 0 }]);
  await echo({ t: 'b', b: 0, d: false, x: 0.125, y: 0.2, n: 3 });
  await expect('right button', { t: 'b', b: 2, d: true, x: 0.125, y: 0.2, n: 1 },
    [{ type: 'rightMouseDown', button: 2, x: r2(X(0.125)), y: r2(Y(0.2)), click: 1, flags: 0 }]);
  await expect('right button up', { t: 'b', b: 2, d: false, x: 0.125, y: 0.2, n: 1 },
    [{ type: 'rightMouseUp', button: 2, x: r2(X(0.125)), y: r2(Y(0.2)), click: 1, flags: 0 }]);
  await expect('middle button', { t: 'b', b: 1, d: true, x: 0.125, y: 0.2, n: 1 },
    [{ type: 'otherMouseDown', button: 1, x: r2(X(0.125)), y: r2(Y(0.2)), click: 1, flags: 0 }]);
  await echo({ t: 'b', b: 1, d: false, x: 0.125, y: 0.2, n: 1 });
  await expect('coordinates outside 0..1 stay on the display', { t: 'm', x: 1.5, y: -0.5 }, [{ type: 'mouseMoved', x: r2(main.width - 1), y: 0, flags: 0 }]);
  await expect('scroll: DOM dy +120 (page moves up) is wheel1 −120, after moving to the spot', { t: 'w', dx: 0, dy: 120, x: 0.5, y: 0.5 },
    [{ type: 'mouseMoved', x: r2(X(0.5)), y: r2(Y(0.5)), flags: 0 }, { type: 'scrollWheel', wheel1: -120, wheel2: 0, x: r2(X(0.5)), y: r2(Y(0.5)), flags: 0 }]);
  await expect('scroll: up and left', { t: 'w', dx: -40, dy: -30, x: 0.5, y: 0.5 },
    [{ type: 'scrollWheel', wheel1: 30, wheel2: 40, x: r2(X(0.5)), y: r2(Y(0.5)), flags: 0 }]);
  const small = [];
  for (let i = 0; i < 3; i++) small.push(...await echo({ t: 'w', dx: 0, dy: 0.4, x: 0.5, y: 0.5 }));
  check('input: fractional scrolls add up to whole pixels', deepEqual(small, [{ type: 'scrollWheel', wheel1: -1, wheel2: 0, x: r2(X(0.5)), y: r2(Y(0.5)), flags: 0 }]), JSON.stringify(small));

  await expect('Command-A down', { t: 'k', c: 'KeyA', k: 'a', d: true, m: 8 }, [{ type: 'keyDown', keyCode: 0, repeat: false, flags: COMMAND }]);
  await expect('held key repeats', { t: 'k', c: 'KeyA', k: 'a', d: true, m: 8 }, [{ type: 'keyDown', keyCode: 0, repeat: true, flags: COMMAND }]);
  await expect('Command-A up', { t: 'k', c: 'KeyA', k: 'a', d: false, m: 8 }, [{ type: 'keyUp', keyCode: 0, flags: COMMAND }]);
  await expect('left Shift down is flagsChanged with its device bit', { t: 'k', c: 'ShiftLeft', k: 'Shift', d: true, m: 1 },
    [{ type: 'flagsChanged', keyCode: 56, down: true, flags: SHIFT | 0x2 }]);
  await expect('Shift-Z carries Shift', { t: 'k', c: 'KeyZ', k: 'Z', d: true, m: 1 }, [{ type: 'keyDown', keyCode: 6, repeat: false, flags: SHIFT | 0x2 }]);
  await echo({ t: 'k', c: 'KeyZ', k: 'Z', d: false, m: 1 });
  await expect('left Shift up', { t: 'k', c: 'ShiftLeft', k: 'Shift', d: false, m: 0 }, [{ type: 'flagsChanged', keyCode: 56, down: false, flags: 0 }]);
  // Spot checks across the table: Return, keypad Enter, Escape, Backspace, forward Delete, F20, arrows, Home, keypad 5,
  // digits, punctuation, right Command, Caps Lock.
  const spots = [['Enter', 36, 0], ['NumpadEnter', 76, NUMPAD], ['Escape', 53, 0], ['Backspace', 51, 0], ['Delete', 117, FN],
    ['F1', 122, FN], ['F20', 90, FN], ['ArrowUp', 126, NUMPAD | FN], ['ArrowLeft', 123, NUMPAD | FN], ['Home', 115, FN], ['PageDown', 121, FN],
    ['Tab', 48, 0], ['Space', 49, 0], ['Numpad5', 87, NUMPAD], ['NumpadMultiply', 67, NUMPAD], ['Digit7', 26, 0], ['Backquote', 50, 0],
    ['BracketLeft', 33, 0], ['Slash', 44, 0], ['IntlBackslash', 10, 0]];
  const wrong = [];
  for (const [code, keyCode, flags] of spots) {
    const down = await echo({ t: 'k', c: code, k: code, d: true, m: 0 });
    const up = await echo({ t: 'k', c: code, k: code, d: false, m: 0 });
    if (!deepEqual(down, [{ type: 'keyDown', keyCode, repeat: false, flags }]) || !deepEqual(up, [{ type: 'keyUp', keyCode, flags }])) {
      wrong.push(`${code} → ${JSON.stringify(down)} / ${JSON.stringify(up)}`);
    }
  }
  check(`input: ${spots.length} keys map to the right Mac key codes and flags`, wrong.length === 0, wrong.join('; '));
  await expect('right Command', { t: 'k', c: 'MetaRight', k: 'Meta', d: true, m: 8 }, [{ type: 'flagsChanged', keyCode: 54, down: true, flags: COMMAND | 0x10 }]);
  await echo({ t: 'k', c: 'MetaRight', k: 'Meta', d: false, m: 0 });
  await expect('Caps Lock toggles (flagsChanged)', { t: 'k', c: 'CapsLock', k: 'CapsLock', d: true, m: 0 }, [{ type: 'flagsChanged', keyCode: 57, down: true, flags: 0 }]);
  await echo({ t: 'k', c: 'CapsLock', k: 'CapsLock', d: false, m: 0 });
  await expect('typed text, accents and emoji included', { t: 'txt', s: 'héllo 😀 wörld' }, [{ type: 'text', s: 'héllo 😀 wörld' }]);
  const long = 'abcdefghij'.repeat(5);
  await expect('long text goes in 20-unit pieces', { t: 'txt', s: long }, [long.slice(0, 20), long.slice(20, 40), long.slice(40)].map(s => ({ type: 'text', s })));
  await expect('a key with no US position types its character', { t: 'k', c: '', k: 'ß', d: true, m: 0 }, [{ type: 'text', s: 'ß' }]);

  // rel lets go of everything held: the button first, then keys, then modifiers.
  await echo({ t: 'k', c: 'KeyB', k: 'b', d: true, m: 0 });
  await echo({ t: 'k', c: 'ControlLeft', k: 'Control', d: true, m: 2 });
  await echo({ t: 'b', b: 0, d: true, x: 0.25, y: 0.75, n: 1 });
  await expect('rel releases the button, then B, then Control', { t: 'rel' }, [
    { type: 'leftMouseUp', button: 0, x: r2(X(0.25)), y: r2(Y(0.75)), click: 1, flags: CONTROL | 0x1 },
    { type: 'keyUp', keyCode: 11, flags: CONTROL | 0x1 },
    { type: 'flagsChanged', keyCode: 59, down: false, flags: 0 }]);
  await expect('nothing left to release', { t: 'rel' }, []);

  // A session ending lets go of whatever the viewer was holding.
  await echo({ t: 'k', c: 'KeyC', k: 'c', d: true, m: 0 });
  const since = got.events.length;
  command('session', { active: true, viewer: 'Safari on iPhone', route: 'passkey' });
  command('session', { active: false });
  const rel = await event('input-echo', { since, where: e => e.ev?.t === 'rel', ms: 2000 });
  check('input: the session ending releases held keys', rel.ev.source === 'app' && deepEqual(rel.out, [{ type: 'keyUp', keyCode: 8, flags: 0 }]), JSON.stringify(rel));
}

async function commandChecks(h) {
  // permissions on request.
  let since = got.events.length;
  command('permissions');
  const p = await event('permissions', { since });
  if (h.synthetic) check('permissions: synthetic + echo count as granted', p.screen === true && p.accessibility === true, JSON.stringify(p));
  else check('permissions event has both booleans', typeof p.screen === 'boolean' && typeof p.accessibility === 'boolean', JSON.stringify(p));

  // status (the menu's contents); without a menu there is nothing to see, but it must be accepted quietly.
  since = got.events.length;
  command('status', { state: 'ready', text: 'Ready: open just-rice.github.io/perch to connect', macName: 'amber-otter-4821',
    setupUrl: 'http://127.0.0.1:9/?k=test', settings: { paused: false, backupOn: false, keepAwake: false, loginItem: false },
    update: { version: '9.9.9' } });
  await settled();
  const complaints = logEvents(since);
  check('status command accepted without complaint', complaints.length === 0, complaints.length ? JSON.stringify(complaints) : '');

  // Power: keep-awake and a session each hold a power assertion while on.
  command('keep-awake', { on: true });
  await settled();
  const awake = assertions();
  command('keep-awake', { on: false });
  await settled();
  const asleep = assertions();
  check('keep-awake on holds PreventUserIdleSystemSleep, off releases it',
    /PreventUserIdleSystemSleep.*Perch is keeping this Mac awake/.test(awake) && !/PreventUserIdleSystemSleep/.test(asleep), `on: ${awake || '(none)'}; off: ${asleep || '(none)'}`);
  command('session', { active: true, viewer: 'Firefox on Linux', route: 'backup' });
  await settled();
  const during = assertions();
  command('session', { active: false });
  await settled();
  const afterSession = assertions();
  check('session active keeps the display awake, inactive lets go',
    /PreventUserIdleDisplaySleep.*Someone is viewing this Mac/.test(during) && !/PreventUserIdleDisplaySleep/.test(afterSession),
    `during: ${during || '(none)'}; after: ${afterSession || '(none)'}`);

  command('notify', { title: 'Test title', body: 'Test body' });
  await settled();

  // Login item: a test run must never change it, and says why.
  since = got.events.length;
  command('login-item', { on: true });
  const li = await event('login-item', { since });
  check('login-item in a test run: refused with a reason, nothing registered', li.on === false && typeof li.status === 'string' && li.status !== 'enabled'
    && typeof li.error === 'string' && li.error.length > 0, JSON.stringify(li));

  // Only web pages may be opened (an http URL would really open a browser, so only refusals are tested).
  since = got.events.length;
  command('open-url', { url: 'file:///etc/hosts' });
  command('open-url', { url: 'javascript:alert(1)' });
  command('open-url', {});
  await settled();
  const opened = logEvents(since).map(e => e.message);
  check('open-url refuses non-http(s) URLs and a missing url', opened.length === 3 && opened.every(m => /refused|without a valid url/.test(m)), JSON.stringify(opened));

  // Things that are wrong get a warning back rather than silence or a crash.
  since = got.events.length;
  command('frobnicate');
  command('bitrate', {});
  command('login-item', {});
  command('capture', { maxEdge: 640, fps: 15, kbps: 800, audio: false }); // no `on`: must not start anything
  sendRaw(frame(T.COMMAND, Buffer.from('this is not json')));
  sendRaw(frame(T.INPUT, Buffer.from('[1,2,3]')));
  sendRaw(frame(0x7f, Buffer.from('from the future')));
  await settled();
  const warnings = logEvents(since).map(e => e.message);
  check('unknown command, missing fields and non-JSON are reported as warnings', warnings.length === 5
    && warnings.every(m => typeof m === 'string') && warnings.some(m => /unknown command "frobnicate"/.test(m)), JSON.stringify(warnings));
  await sleep(500);
  check('a capture command without "on" starts nothing', warnings.some(m => /capture without on/.test(m))
    && !got.events.slice(since).some(x => x.ev.e === 'capture-started'), JSON.stringify(warnings));
  check('the app never sent an unknown or malformed frame', got.bad.length === 0, got.bad.join('; '));
}

function logChecks() {
  if (!APP_LOG) { log('PERCH_HOME is not set, so the app log checks are skipped'); return; }
  const text = appLog();
  check('the host\'s stderr is copied into the app log', text.includes(`[host] fake-host: ${MARKER}`));
  check('the app logs the session and the notifications it could not show here',
    text.includes('session started: Safari on iPhone via passkey') && text.includes('Safari on iPhone is viewing this Mac')
      && text.includes('Test title — Test body'));
}

async function finish(how = 'quit', extra = {}) {
  const since = got.events.length;
  const t = performance.now();
  if (how === 'uninstall') command('uninstall');
  else command('quit');
  await until(() => got.ended, 4000, 'the app to close our input').catch(e => check('the app closes the host\'s input when quitting', false, e.message));
  if (got.ended) check(`${how}: the app closed the host's input within 2 s`, performance.now() - t < 2000, `${Math.round(performance.now() - t)} ms`);
  if (how === 'uninstall') {
    const w = logEvents(since).map(e => e.message);
    check('uninstall in a test run: refused, nothing removed, app quits', w.some(m => /not removing anything/.test(m)), JSON.stringify(w));
  }
  report();
}

function report() {
  const failed = results.filter(r => !r.ok);
  const lines = results.map(r => r.line);
  lines.push(`fake-host (${MODE}): ${results.length - failed.length} passed, ${failed.length} failed`);
  log(lines.at(-1));
  if (process.env.PERCH_FAKE_REPORT) writeFileSync(process.env.PERCH_FAKE_REPORT, lines.join('\n') + '\n');
  try { rmSync(STATE, { force: true }); } catch {}
  process.exit(failed.length ? 1 : 0);
}

async function main() {
  log(MARKER);
  const watchdog = setTimeout(() => { check('finished in time', false, 'still running after 150 s'); report(); }, 150_000);
  watchdog.unref();
  const state = readState();
  if (MODE === 'synthetic' && state.runs === 0) return crashRun(state);
  if (MODE === 'synthetic' && state.runs === 1) return garbageRun(state);
  if (MODE === 'synthetic') {
    for (const r of state.results ?? []) check(r.name, r.ok, r.detail);
    const gap = Date.now() - state.exitAt;
    await until(() => got.hello, 5000, 'HELLO');
    check('app restarted the host again, after a longer wait (about 2 s)', gap >= 1700 && gap < 5000, `${gap} ms`);
  }
  const h = await helloChecks();

  if (MODE === 'ui') {
    await section('menu bar', async () => {
      await settled();
      check('menu bar icon starts idle', appLog().includes('menu bar icon: idle'));
      command('status', { state: 'ready', text: 'Ready', macName: 'amber-otter-4821', setupUrl: 'http://127.0.0.1:9/?k=test',
        settings: { paused: false, backupOn: false, keepAwake: false, loginItem: false } });
      command('session', { active: true, viewer: 'Safari on iPhone', route: 'passkey' });
      await settled();
      check('menu bar icon lights up while a viewer is connected', appLog().includes('menu bar icon: connected'));
      await sleep(1500); // long enough to see it
      command('session', { active: false });
      await settled();
      check('menu bar icon goes back to idle', appLog().split('menu bar icon: idle').length === 3);
    });
    return finish();
  }

  if (MODE === 'bundle') {
    const here = fileURLToPath(import.meta.url);
    check('bundle: host script runs from Contents/Resources/host', here.endsWith('/Perch.app/Contents/Resources/host/perch-host.mjs'), here);
    check('bundle: node runs from Contents/Helpers', process.execPath.endsWith('/Perch.app/Contents/Helpers/node'), process.execPath);
    check('bundle: the version comes from Info.plist', h.version === '0.1.0', h.version);
    // A bundle that has never registered reports SMAppService's notFound; once registered and removed, notRegistered.
    check('bundle: login item status is SMAppService\'s', ['not-found', 'not-registered', 'enabled', 'requires-approval'].includes(h.loginItem.status),
      JSON.stringify(h.loginItem));
    await section('bundle capture', async () => {
      const since = got.events.length, mark = got.video.length;
      command('capture', { on: true, maxEdge: 960, fps: 30, kbps: 2000, audio: true });
      const s = await event('capture-started', { since, ms: 5000 });
      const k = await until(() => got.video.slice(mark).find(f => f.key), 3000, 'a keyframe');
      await until(() => got.audio.length > 5, 3000, 'audio');
      check('bundle: capture works (960x540 keyframe with SPS, audio)', s.width === 960 && parseSps(nalUnits(k.data)[0]).width === 960);
      command('capture', { on: false });
      await event('capture-stopped', { since });
    });
    await section('bundle input', async () => {
      const out = await echo({ t: 'm', x: 0.5, y: 0.5 });
      check('bundle: input echo works', deepEqual(out, [{ type: 'mouseMoved', x: 960, y: 540, flags: 0 }]), JSON.stringify(out));
    });
    await section('bundle login item', async () => {
      const since = got.events.length;
      command('login-item', { on: true });
      const li = await event('login-item', { since });
      check('bundle: login-item refused in a test run', li.status !== 'enabled' && typeof li.error === 'string', JSON.stringify(li));
    });
    return finish('uninstall');
  }

  await section('commands', () => commandChecks(h));
  await section('capture', () => captureChecks(h));
  await section('input', () => inputChecks(h));
  logChecks();
  await finish();
}

main().catch(e => { check('fake host ran', false, e.stack); report(); });

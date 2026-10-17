// A stand-in for the Swift app in host tests: it starts the host (src/main.mjs, or the bundle) as a child process
// exactly as the app does, says HELLO, answers commands, plays the committed fixtures (test/fixtures/) as VIDEO and
// AUDIO frames while capture is on, and echoes every INPUT frame back as an `input-echo` event, as the app does
// with --echo-input. Nothing here touches the real screen, keyboard or mouse.
//
// The host runs in test mode against the given local broker, with its own temporary home, file secrets and no STUN.
// A fourth pipe (fd 3) carries the test control channel (src/test-rpc.mjs), standing in for the Setup page.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { FrameReader, T, encodeJson, encodeVideo, encodeAudio } from '../src/ipc.mjs';
import { splitAnnexB, groupAccessUnits } from '../src/h264.mjs';
import { fromBase32, totp } from '../src/totp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAIN = join(HERE, '..', 'src', 'main.mjs');
export const FIXTURES = join(HERE, 'fixtures');
export const TEST_ORIGIN = 'http://localhost:8765';
export const TEST_RP_ID = 'localhost';
export const TEST_SITE = `${TEST_ORIGIN}/connect.html`;
export const DISPLAYS = [
  { id: 1, name: 'Built-in Display', width: 1512, height: 982, main: true },
  { id: 2, name: 'Studio Display', width: 2560, height: 1440, main: false },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- fixtures ---

let cached = null;
export function loadFixtures() {
  if (cached) return cached;
  const aus = groupAccessUnits(splitAnnexB(readFileSync(join(FIXTURES, 'clip.h264'))));
  // Back to Annex-B access units, the way the app sends them (4-byte start codes).
  const start = Buffer.of(0, 0, 0, 1);
  const video = aus.map(au => ({ keyframe: au.keyframe, data: Buffer.concat(au.nals.flatMap(n => [start, n])) }));
  const raw = readFileSync(join(FIXTURES, 'clip.opusl'));
  const audio = [];
  for (let o = 0; o + 2 <= raw.length;) {
    const len = raw.readUInt16BE(o);
    audio.push(raw.subarray(o + 2, o + 2 + len));
    o += 2 + len;
  }
  cached = { video, audio };
  return cached;
}

// Plays the fixtures in a loop at 30 fps and 50 Opus packets a second, with steadily rising timestamps. A keyframe
// request makes the next frame the next keyframe in the clip, like an encoder forcing one.
class Player {
  constructor(send) {
    this.send = send;
    this.fx = loadFixtures();
    this.vi = 0;
    this.ai = 0;
    this.timers = [];
    this.wantKeyframe = true;
    this.t0 = 0;
    this.sent = { video: 0, audio: 0, keyframes: 0 };
  }
  get running() { return this.timers.length > 0; }
  start() {
    if (this.running) return;
    this.t0 = performance.now();
    this.wantKeyframe = true;
    this.timers.push(setInterval(() => this._video(), 1000 / 30));
    this.timers.push(setInterval(() => this._audio(), 20));
  }
  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
  keyframe() { this.wantKeyframe = true; }
  _pts() { return Math.round((performance.now() - this.t0) * 1000) + 1_000_000; }
  _video() {
    const list = this.fx.video;
    if (this.wantKeyframe) {
      while (!list[this.vi % list.length].keyframe) this.vi++;
      this.wantKeyframe = false;
    }
    const f = list[this.vi++ % list.length];
    if (f.keyframe) this.sent.keyframes++;
    this.sent.video++;
    this.send(encodeVideo({ keyframe: f.keyframe, ptsUs: this._pts(), data: f.data }));
  }
  _audio() {
    const list = this.fx.audio;
    this.sent.audio++;
    this.send(encodeAudio({ ptsUs: this._pts(), data: list[this.ai++ % list.length] }));
  }
}

// --- the fake app ---

export class FakeApp extends EventEmitter {
  constructor({ child, home, ownHome, streamAlways, permissions, displays }) {
    super();
    Object.assign(this, { child, home, ownHome, streamAlways, permissions, displays });
    this.commands = [];
    this.inputs = [];
    this.log = '';
    this.exited = null;
    this.clockOffset = 0;
    this.totpSecret = null;
    this.player = new Player(buf => this._write(buf));
    this.reader = new FrameReader();
    this.rpcId = 0;
    this.rpcWaiting = new Map();
    this.rpcBuf = '';
    this.exitPromise = new Promise(r => child.once('exit', (code, signal) => { this.exited = { code, signal }; this.player.stop(); r(this.exited); }));
    child.stdout.on('data', d => {
      let frames;
      try { frames = this.reader.push(d); } catch (e) { this.emit('ipc-error', e); return; }
      for (const f of frames) this._frame(f);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => {
      this.log += d;
      if (this.log.length > 4_000_000) this.log = this.log.slice(-2_000_000);
      if (process.env.PERCH_TEST_ECHO_LOG) process.stderr.write(d);
    });
    child.stdin.on('error', () => {});
    const rpc = child.stdio[3];
    rpc.setEncoding('utf8');
    rpc.on('data', d => {
      this.rpcBuf += d;
      for (let i; (i = this.rpcBuf.indexOf('\n')) >= 0;) {
        const line = this.rpcBuf.slice(0, i);
        this.rpcBuf = this.rpcBuf.slice(i + 1);
        const m = JSON.parse(line);
        const w = this.rpcWaiting.get(m.id);
        if (!w) continue;
        this.rpcWaiting.delete(m.id);
        if (m.error !== undefined) w.reject(new Error(m.error)); else w.resolve(m.result);
      }
    });
    rpc.on('error', () => {});
  }

  _write(buf) {
    if (this.exited || this.child.stdin.destroyed) return;
    this.child.stdin.write(buf);
  }

  hello(extra = {}) {
    this._write(encodeJson(T.HELLO, {
      app: 'Perch', version: '1.2.3', ipc: 1, macos: '15.0.0', synthetic: true,
      permissions: this.permissions, displays: this.displays, loginItem: { on: false, status: 'not-found' }, ...extra,
    }));
    this.event({ e: 'lock', locked: false });
  }

  event(obj) { this._write(encodeJson(T.EVENT, obj)); }

  setPermissions(p) {
    this.permissions = { ...this.permissions, ...p };
    this.event({ e: 'permissions', ...this.permissions });
  }

  _frame({ type, payload }) {
    if (type === T.COMMAND) {
      const cmd = JSON.parse(payload.toString('utf8'));
      cmd.at = Date.now();
      this.commands.push(cmd);
      this._command(cmd);
      this.emit('command', cmd);
    } else if (type === T.INPUT) {
      const ev = JSON.parse(payload.toString('utf8'));
      this.inputs.push({ ev, at: Date.now() });
      this.event({ e: 'input-echo', ev });
      this.emit('input', ev);
    } else {
      this.emit('ipc-error', new Error(`the host sent frame type ${type}`));
    }
  }

  _command(cmd) {
    switch (cmd.c) {
      case 'capture':
        if (cmd.on) {
          this.player.start();
          this.player.keyframe();
          this.event({ e: 'capture-started', display: cmd.display ?? 1, width: 640, height: 360, fps: cmd.fps ?? 30 });
        } else {
          if (!this.streamAlways) this.player.stop();
          this.event({ e: 'capture-stopped', reason: 'requested' });
        }
        break;
      case 'keyframe':
        this.player.keyframe();
        break;
      case 'permissions':
        this.event({ e: 'permissions', ...this.permissions });
        break;
      case 'login-item':
        this.event({ e: 'login-item', on: !!cmd.on, status: cmd.on ? 'enabled' : 'not-registered' });
        break;
    }
  }

  // Calls a controller method in the host (src/test-rpc.mjs).
  call(method, ...args) {
    const id = ++this.rpcId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rpcWaiting.delete(id); reject(new Error(`no answer to ${method}`)); }, 20000);
      this.rpcWaiting.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.child.stdio[3].write(JSON.stringify({ id, method, args }) + '\n');
    });
  }

  // Moves the host's sign-in clock forward (codes, lockouts, link expiry); codes made here follow it.
  async advance(ms) {
    this.clockOffset = await this.call('advanceClock', ms);
    return this.clockOffset;
  }

  // Sets up the authenticator app the way the Setup page does, keeping the secret so tests can make codes.
  async setupTotp() {
    const { secret, uri } = await this.call('totpStart');
    this.totpSecret = fromBase32(secret);
    await this.call('totpConfirm', this.code());
    return { secret, uri };
  }

  // The code for the host's current 30-second step.
  code(offsetMs = 0) {
    return totp(this.totpSecret, Date.now() + this.clockOffset + offsetMs);
  }

  // A code that has certainly not been used yet: moves the host's clock to the next step first.
  async freshCode() {
    await this.advance(30_000);
    return this.code();
  }

  async waitFor(pred, { timeoutMs = 10000, what = 'condition' } = {}) {
    const t0 = Date.now();
    for (;;) {
      const v = await pred();
      if (v) return v;
      if (this.exited) throw new Error(`host exited (${JSON.stringify(this.exited)}) while waiting for ${what}\n${this.log.slice(-3000)}`);
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  waitForCommand(pred, opts = {}) {
    const from = opts.since ?? 0;
    return this.waitFor(() => this.commands.slice(from).find(pred), { what: 'command', ...opts });
  }

  waitForLog(re, opts = {}) {
    return this.waitFor(() => re.test(this.log), { what: `log ${re}`, ...opts });
  }

  // Ends the host the way the app does: close its stdin, wait, then insist.
  async stop() {
    this.player.stop();
    if (!this.exited) {
      try { this.child.stdin.end(); } catch {}
      const done = await Promise.race([this.exitPromise, sleep(4000).then(() => null)]);
      if (!done) {
        this.child.kill('SIGKILL');
        await this.exitPromise;
      }
    }
    try { this.child.stdio[3].destroy(); } catch {}
    if (this.ownHome) rmSync(this.home, { recursive: true, force: true });
    return this.exited;
  }
}

// Starts a host in test mode. `entry` may point at the bundle (dist/perch-host.mjs) instead of src/main.mjs.
export async function startHost({
  broker, home = null, entry = process.env.PERCH_TEST_HOST_ENTRY || MAIN, origin = TEST_ORIGIN, rpId = TEST_RP_ID,
  site = TEST_SITE, env = {}, streamAlways = false, hello = true,
  permissions = { screen: true, accessibility: true }, displays = DISPLAYS, setupPort = '0', online = true,
} = {}) {
  const ownHome = !home;
  home ??= mkdtempSync(join(tmpdir(), 'perch-host-'));
  const child = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PERCH_TEST: '1', PERCH_HOME: home, PERCH_SECRETS: 'file', PERCH_BROKERS: broker, PERCH_ICE: 'none',
      PERCH_TEST_ORIGIN: origin, PERCH_RP_ID: rpId, PERCH_SITE: site, PERCH_SETUP_PORT: setupPort,
      PERCH_TEST_RPC_FD: '3', PERCH_LOG: 'debug', ...env,
    },
  });
  const app = new FakeApp({ child, home, ownHome, streamAlways, permissions, displays });
  if (streamAlways) app.player.start();
  if (hello) app.hello();
  // The control channel answers once the host is fully up.
  await app.call('state');
  // Until the host has reached the broker, a viewer's hello would go nowhere (QoS 0 keeps nothing for later).
  if (online) {
    await app.waitFor(async () => (await app.call('state')).rendezvous.some(r => r.connected), { what: 'the host to reach the broker' });
  }
  return app;
}

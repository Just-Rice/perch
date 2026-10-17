// The host must never outlive its app or spin. When the app's ends of the pipes go away (the app crashed or was
// killed), the host stops promptly instead of looping on the broken pipe (EPIPE) at full speed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeJson, T } from '../src/ipc.mjs';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.mjs');

function startBare() {
  const home = mkdtempSync(join(tmpdir(), 'perch-life-'));
  const child = spawn(process.execPath, [MAIN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PERCH_TEST: '1', PERCH_HOME: home,
      PERCH_SECRETS: 'file', PERCH_BROKERS: 'ws://127.0.0.1:1/mqtt', PERCH_ICE: 'none', PERCH_LOG: 'debug' },
  });
  child.stdout.on('data', () => {});
  const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
  return { child, home, exited };
}

const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

test('the host exits when the app goes away, even with its stderr already gone', async () => {
  const { child, home, exited } = startBare();
  child.stdin.write(encodeJson(T.HELLO, { app: 'Perch', version: '1.0.0', ipc: 1, macos: '15.0.0', synthetic: true,
    permissions: { screen: true, accessibility: true }, displays: [], loginItem: { on: false, status: 'not-found' } }));
  await new Promise(r => setTimeout(r, 800));
  // The app dies: first its stderr reader, then everything else. The host keeps logging (rendezvous retries) into a
  // broken stderr in between.
  child.stderr.destroy();
  await new Promise(r => setTimeout(r, 1500));
  child.stdout.destroy();
  child.stdin.end();
  const result = await within(exited, 5000);
  if (!result) child.kill('SIGKILL');
  rmSync(home, { recursive: true, force: true });
  assert.ok(result, 'the host stopped by itself within 5 s');
});

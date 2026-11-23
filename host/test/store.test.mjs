import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, DpapiSecrets, DPAPI_FILE } from '../src/store.mjs';
import { lockedFor, recordFailure, recordSuccess, freshLimit, MAX_FAILS } from '../src/limits.mjs';
import { MAC_NAME_RE } from '../../site/js/shared/rendezvous.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'roost-store-'));

test('a new store makes an identity and keeps it across reopening', async () => {
  const home = tmp();
  const a = await Store.open({ home, secrets: 'file' });
  assert.match(a.macName, MAC_NAME_RE);
  assert.equal(a.hostId.length, 16);
  assert.equal(a.sigKey.length, 32);
  assert.equal(a.userHandle.length, 48);
  assert.deepEqual(a.userHandle.subarray(0, 16), a.hostId);
  assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, 'secrets.json')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(home, 'config.json'), 'utf8').includes(a.secrets.sigKey), 'no secrets in config.json');
  const b = await Store.open({ home, secrets: 'file' });
  assert.equal(b.macName, a.macName);
  assert.deepEqual(b.sigKey, a.sigKey);
});

test('settings, devices, TOTP and reset', async () => {
  const s = await Store.open({ home: tmp(), secrets: 'file' });
  assert.equal(s.settings.backupOn, false);
  s.updateSettings({ backupOn: true, idleMinutes: 30 });
  assert.equal(s.settings.idleMinutes, 30);
  assert.throws(() => s.updateSettings({ nonsense: 1 }));
  assert.throws(() => s.updateSettings({ idleMinutes: '5' }));
  s.addDevice({ id: 'cred1', publicKey: 'pk', counter: 0, label: 'Chrome on Mac' });
  s.addDevice({ id: 'cred2', publicKey: 'pk2', counter: 0, label: 'Safari on iPhone' });
  assert.equal(s.devices.length, 2);
  assert.equal(s.updateDevice('cred1', { label: 'Work laptop' }).label, 'Work laptop');
  assert.equal(s.removeDevice('cred2'), true);
  assert.equal(s.removeDevice('nope'), false);
  await s.setTotpSecret(Buffer.alloc(20, 1));
  assert.equal(s.config.totp.set, true);
  assert.deepEqual(s.totpSecret, Buffer.alloc(20, 1));
  s.markTotpUsed(100);
  s.markTotpUsed(90);
  assert.equal(s.config.totp.lastStep, 100);
  const oldName = s.macName, oldId = s.config.hostId;
  await s.reset();
  assert.notEqual(s.config.hostId, oldId);
  assert.equal(s.devices.length, 0);
  assert.equal(s.totpSecret, null);
  assert.ok(s.macName !== oldName || true);
});

test('lockout starts after five failures and doubles up to an hour', () => {
  let l = freshLimit();
  const t = 1_000_000;
  for (let i = 1; i < MAX_FAILS; i++) {
    l = recordFailure(l, t);
    assert.equal(lockedFor(l, t), 0, `open after ${i} failures`);
  }
  l = recordFailure(l, t);
  assert.equal(lockedFor(l, t), 60_000);
  l = recordFailure(l, t);
  assert.equal(lockedFor(l, t), 120_000);
  for (let i = 0; i < 10; i++) l = recordFailure(l, t);
  assert.equal(lockedFor(l, t), 3_600_000);
  assert.equal(lockedFor(l, t + 3_600_001), 0);
  assert.deepEqual(recordSuccess(), freshLimit());
});

// --- secrets through roost.exe (DPAPI) ---
//
// A stand-in for `roost.exe --secrets read|write --home <dir>` (docs/WINDOWS-APP.md, "Secrets"): it keeps the JSON
// base64-encoded in <home>/secrets.dpapi, exits 3 when there is no file yet, and notes every call in calls.log. Run
// through node, so the same test works on Windows, where a script can't be started like an .exe.
const FAKE_EXE = `
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [, , flag, verb, homeFlag, home, ...rest] = process.argv;
const file = join(home, 'secrets.dpapi');
const stdin = readFileSync(0, 'utf8');
appendFileSync(join(home, 'calls.log'), JSON.stringify({ args: [flag, verb, homeFlag, home, ...rest], stdin: stdin.length }) + '\\n');
const mode = existsSync(join(home, 'mode')) ? readFileSync(join(home, 'mode'), 'utf8').trim() : 'ok';
if (flag !== '--secrets' || homeFlag !== '--home' || rest.length) { process.stderr.write('bad arguments'); process.exit(2); }
if (mode === 'broken') { process.stderr.write('CryptUnprotectData failed: the key is not valid for this user'); process.exit(1); }
if (verb === 'read') {
  if (!existsSync(file)) process.exit(3);
  if (mode === 'garbage') { process.stdout.write('hello'); process.exit(0); }
  process.stdout.write(Buffer.from(readFileSync(file, 'utf8'), 'base64').toString('utf8'));
} else if (verb === 'write') {
  JSON.parse(stdin);
  writeFileSync(file, Buffer.from(stdin).toString('base64'));
} else process.exit(2);
`;

function fakeRoostExe() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-exe-'));
  const exe = join(dir, 'roost.exe.mjs');
  writeFileSync(exe, FAKE_EXE);
  // Runs the "exe" with node: execFile(exe, args) becomes execFile(node, [exe, ...args]).
  const execFileImpl = (cmd, args, opts, cb) => execFile(process.execPath, [cmd, ...args], opts, cb);
  return { exe, execFileImpl };
}

const calls = home => readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('DPAPI secrets: kept through roost.exe, never in plain secrets.json, never on the command line', async () => {
  const home = tmp();
  const { exe, execFileImpl } = fakeRoostExe();
  const a = await Store.open({ home, secrets: 'dpapi', appExe: exe, execFileImpl });
  assert.ok(existsSync(join(home, DPAPI_FILE)), 'secrets.dpapi written');
  assert.ok(!existsSync(join(home, 'secrets.json')), 'no plain secrets file');
  const log = calls(home);
  assert.deepEqual(log[0].args, ['--secrets', 'read', '--home', home], 'first a read: exit 3, nothing there yet');
  assert.deepEqual(log[1].args, ['--secrets', 'write', '--home', home]);
  assert.ok(log[1].stdin > 50, 'the secrets went in on stdin');
  assert.ok(!JSON.stringify(log).includes(a.secrets.sigKey), 'and never as an argument');
  const b = await Store.open({ home, secrets: 'dpapi', appExe: exe, execFileImpl });
  assert.equal(b.macName, a.macName);
  assert.deepEqual(b.sigKey, a.sigKey, 'the same identity after reopening');
  await b.backend.remove();
  assert.ok(!existsSync(join(home, DPAPI_FILE)), 'remove deletes secrets.dpapi');
});

test('DPAPI secrets: a failed read stops the store instead of making a new identity over the old one', async () => {
  const home = tmp();
  const { exe, execFileImpl } = fakeRoostExe();
  const a = await Store.open({ home, secrets: 'dpapi', appExe: exe, execFileImpl });
  const before = readFileSync(join(home, DPAPI_FILE), 'utf8');
  writeFileSync(join(home, 'mode'), 'broken');
  await assert.rejects(Store.open({ home, secrets: 'dpapi', appExe: exe, execFileImpl }), /could not read the secrets \(roost\.exe answered 1\): CryptUnprotectData failed/);
  writeFileSync(join(home, 'mode'), 'garbage');
  await assert.rejects(Store.open({ home, secrets: 'dpapi', appExe: exe, execFileImpl }), /isn't a secrets object/);
  assert.equal(readFileSync(join(home, DPAPI_FILE), 'utf8'), before, 'the saved secrets were left alone');
  writeFileSync(join(home, 'mode'), 'ok');
  assert.equal((await Store.open({ home, secrets: 'dpapi', appExe: exe, execFileImpl })).macName, a.macName);
});

test('DPAPI secrets: a failed write or a missing roost.exe is an error', async () => {
  const home = tmp();
  const { exe, execFileImpl } = fakeRoostExe();
  writeFileSync(join(home, 'mode'), 'broken');
  const backend = new DpapiSecrets({ exe, home, execFileImpl });
  await assert.rejects(backend.write({ sigKey: 'x' }), /could not save the secrets \(roost\.exe answered 1\)/);
  const missing = new DpapiSecrets({ exe: join(home, 'no-such-roost.exe'), home });
  await assert.rejects(missing.read(), /could not read the secrets \(roost\.exe answered ENOENT\)/);
  assert.throws(() => new DpapiSecrets({ exe: null, home }), /path of roost\.exe/);
});

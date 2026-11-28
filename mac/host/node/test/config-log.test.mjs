// The environment can only change the host's behaviour in test mode, and logging goes to stderr and a rotated file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createLog } from '../src/log.mjs';
import { defaultHome } from '../src/store.mjs';
import { APP_ORIGIN, RP_ID, CONNECT_URL, BROKERS, ICE_SERVERS } from '../../../site/js/shared/proto.js';

const OVERRIDES = {
  PERCH_HOME: '/tmp/x', PERCH_SECRETS: 'file', PERCH_BROKERS: 'ws://127.0.0.1:1/mqtt',
  PERCH_TEST_ORIGIN: 'http://localhost:8765', PERCH_RP_ID: 'localhost', PERCH_SITE: 'http://localhost:8765/c.html',
  PERCH_SETUP_PORT: '4321', PERCH_SETUP_KEY: 'k'.repeat(30), PERCH_ICE: 'none', PERCH_TEST_RPC_FD: '3',
};

test('without PERCH_TEST=1 every override is ignored', () => {
  for (const test of [undefined, '0', 'true', 'yes', '']) {
    const c = loadConfig({ ...OVERRIDES, ...(test === undefined ? {} : { PERCH_TEST: test }) });
    assert.equal(c.test, false);
    assert.equal(c.home, defaultHome());
    assert.equal(c.secrets, 'keychain');
    assert.deepEqual(c.brokers, BROKERS);
    assert.deepEqual(c.origins, [APP_ORIGIN]);
    assert.equal(c.rpId, RP_ID);
    assert.equal(c.site, CONNECT_URL);
    assert.equal(c.setupPort, 0);
    assert.notEqual(c.setupKey, OVERRIDES.PERCH_SETUP_KEY);
    assert.match(c.setupKey, /^[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(c.iceServers, ICE_SERVERS);
    assert.equal(c.iceLoopback, false);
    assert.equal(c.testRpcFd, null);
  }
});

test('with PERCH_TEST=1 the overrides apply, and bad ones are refused', () => {
  const c = loadConfig({ ...OVERRIDES, PERCH_TEST: '1' });
  assert.equal(c.test, true);
  assert.equal(c.home, '/tmp/x');
  assert.equal(c.secrets, 'file');
  assert.deepEqual(c.brokers, ['ws://127.0.0.1:1/mqtt']);
  assert.deepEqual(c.origins, [APP_ORIGIN, 'http://localhost:8765'], 'the real origin stays allowed');
  assert.equal(c.rpId, 'localhost');
  assert.equal(c.site, 'http://localhost:8765/c.html');
  assert.equal(c.setupPort, 4321);
  assert.equal(c.setupKey, OVERRIDES.PERCH_SETUP_KEY);
  assert.deepEqual(c.iceServers, []);
  assert.equal(c.iceLoopback, true);
  assert.equal(c.testRpcFd, 3);
  assert.throws(() => loadConfig({ PERCH_TEST: '1', PERCH_BROKERS: 'http://x' }), /ws:\/\//);
  assert.throws(() => loadConfig({ PERCH_TEST: '1', PERCH_TEST_ORIGIN: 'javascript:alert(1)' }), /http/);
  assert.throws(() => loadConfig({ PERCH_TEST: '1', PERCH_SETUP_PORT: '99999' }), /port/);
  assert.throws(() => loadConfig({ PERCH_TEST: '1', PERCH_TEST_RPC_FD: '1' }), /file descriptor/);
  // An origin is reduced to its origin: a path can't sneak in.
  assert.deepEqual(loadConfig({ PERCH_TEST: '1', PERCH_TEST_ORIGIN: 'http://localhost:9/a/b?c' }).origins[1], 'http://localhost:9');
});

test('the app version from the environment is used only when it looks like a version', () => {
  assert.equal(loadConfig({ PERCH_APP_VERSION: '1.4.2' }).appVersion, '1.4.2');
  assert.equal(loadConfig({ PERCH_APP_VERSION: '1.4.2-beta.1' }).appVersion, '1.4.2-beta.1');
  assert.equal(loadConfig({ PERCH_APP_VERSION: '<script>' }).appVersion, null);
  assert.equal(loadConfig({}).appVersion, null);
});

function fakeStderr() {
  const lines = [];
  return { lines, write: s => { lines.push(s); return true; } };
}

test('logging: levels, tags and errors, to stderr and a private file', () => {
  const home = mkdtempSync(join(tmpdir(), 'perch-log-'));
  try {
    const stderr = fakeStderr();
    const log = createLog({ home, level: 'info', stderr });
    log.debug('hidden');
    log('plain info', { a: 1 });
    log.warn('careful');
    log.child('rtc').error('boom', new Error('bad thing'));
    assert.equal(stderr.lines.length, 3);
    assert.match(stderr.lines[0], /INFO {2}plain info {"a":1}\n$/);
    assert.match(stderr.lines[1], /WARN {2}careful/);
    assert.match(stderr.lines[2], /ERROR \[rtc\] boom Error: bad thing/);
    const file = readFileSync(join(home, 'perch.log'), 'utf8');
    assert.equal(file, stderr.lines.join(''));
    assert.equal(statSync(join(home, 'perch.log')).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the log file is rotated when it reaches the limit', () => {
  const home = mkdtempSync(join(tmpdir(), 'perch-log-'));
  try {
    writeFileSync(join(home, 'perch.log'), 'x'.repeat(900));
    const log = createLog({ home, level: 'debug', stderr: fakeStderr(), maxBytes: 1000 });
    for (let i = 0; i < 40; i++) log(`line ${i} ${'y'.repeat(40)}`);
    assert.ok(existsSync(join(home, 'perch.log.1')));
    assert.ok(statSync(join(home, 'perch.log')).size <= 1000);
    assert.ok(statSync(join(home, 'perch.log.1')).size <= 1000);
    assert.match(readFileSync(join(home, 'perch.log'), 'utf8'), /line 39/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a log file that cannot be written does not stop logging to stderr', () => {
  const stderr = fakeStderr();
  const log = createLog({ home: '/dev/null/not-a-dir', stderr });
  log('still here');
  assert.equal(stderr.lines.length, 1);
});

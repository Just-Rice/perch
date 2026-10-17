// The updater: version comparison, reading GitHub's latest release (with a fake fetch, never the network) and
// starting the install script (with a fake spawn, never for real). Run: node --test test/updater.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkForUpdate, installUpdate, parseVersion, compareVersions, LATEST_RELEASE_API, INSTALL_COMMAND,
} from '../src/updater.mjs';

const release = (over = {}) => ({
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/Just-Rice/perch/releases/tag/v0.2.0',
  draft: false,
  prerelease: false,
  body: 'Smoother video on slow networks.\r\n\r\nFixes a crash when a display is unplugged.',
  ...over,
});

// A fake fetch that records what it was asked and answers with `answer` (an object -> 200 JSON, a function, or an Error).
function fakeFetch(answer, status = 200) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'function') return answer(url, opts);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof answer === 'string' ? JSON.parse(answer) : answer),
    };
  };
  fn.calls = calls;
  return fn;
}

const quiet = () => {};

test('versions compare the SemVer way', () => {
  // The ordering example from semver.org §11, plus some of our own.
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11',
    '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '1.9.0', '1.10.0', '2.0.0', '10.0.0'];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      const c = Math.sign(compareVersions(ordered[i], ordered[j]));
      assert.equal(c, Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0, 'a leading v is fine');
  assert.equal(compareVersions('1.2.3+build.7', '1.2.3+other'), 0, 'build metadata is ignored');
  assert.deepEqual(parseVersion('v1.2.3-beta.2+b5'), { major: 1, minor: 2, patch: 3, pre: ['beta', 2] });
  for (const bad of ['', '1', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.3-01', '1.2.3-', 'latest', 'v', null, undefined, 42]) {
    assert.equal(parseVersion(bad), null, `not a version: ${bad}`);
  }
  assert.throws(() => compareVersions('1.0.0', 'nope'));
});

test('a newer release is offered, with its page and short notes', async () => {
  const f = fakeFetch(release());
  const u = await checkForUpdate('0.1.0', { fetchImpl: f, log: quiet });
  assert.deepEqual(u, {
    version: '0.2.0',
    url: 'https://github.com/Just-Rice/perch/releases/tag/v0.2.0',
    notes: 'Smoother video on slow networks.\n\nFixes a crash when a display is unplugged.',
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, LATEST_RELEASE_API);
  assert.equal(LATEST_RELEASE_API, 'https://api.github.com/repos/Just-Rice/perch/releases/latest');
  const headers = f.calls[0].opts.headers;
  assert.match(headers['User-Agent'], /^Perch\/0\.1\.0 /);
  assert.equal(headers.Accept, 'application/vnd.github+json');
  assert.ok(f.calls[0].opts.signal instanceof AbortSignal, 'has a timeout');
  // A release after a pre-release of the same version counts as newer.
  assert.equal((await checkForUpdate('0.2.0-beta.3', { fetchImpl: fakeFetch(release()), log: quiet }))?.version, '0.2.0');
  // Two-digit parts compare as numbers, not text.
  assert.equal((await checkForUpdate('0.9.0', { fetchImpl: fakeFetch(release({ tag_name: 'v0.10.0' })), log: quiet }))?.version, '0.10.0');
  // A tag without the v, and with build metadata.
  assert.equal((await checkForUpdate('0.1.0', { fetchImpl: fakeFetch(release({ tag_name: '0.3.1+mac' })), log: quiet }))?.version, '0.3.1');
});

test('the same or an older release is no update', async () => {
  assert.equal(await checkForUpdate('0.2.0', { fetchImpl: fakeFetch(release()), log: quiet }), null);
  assert.equal(await checkForUpdate('v0.2.0', { fetchImpl: fakeFetch(release()), log: quiet }), null);
  assert.equal(await checkForUpdate('0.3.0', { fetchImpl: fakeFetch(release()), log: quiet }), null);
  assert.equal(await checkForUpdate('1.0.0', { fetchImpl: fakeFetch(release({ tag_name: 'v0.10.0' })), log: quiet }), null);
});

test('drafts and pre-releases are ignored', async () => {
  assert.equal(await checkForUpdate('0.1.0', { fetchImpl: fakeFetch(release({ prerelease: true })), log: quiet }), null);
  assert.equal(await checkForUpdate('0.1.0', { fetchImpl: fakeFetch(release({ draft: true })), log: quiet }), null);
});

test('strange answers and network trouble are "no update", never an error', async () => {
  const logs = [];
  const log = (m) => logs.push(m);
  const cases = {
    'no tag': release({ tag_name: undefined }),
    'tag not a version': release({ tag_name: 'nightly' }),
    'tag a number': release({ tag_name: 3 }),
    'an array': [release()],
    'null': null,
    'a string': 'v0.2.0',
  };
  for (const [what, answer] of Object.entries(cases)) {
    assert.equal(await checkForUpdate('0.1.0', { fetchImpl: fakeFetch(answer), log }), null, what);
  }
  // Bad JSON.
  const badJson = fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
  assert.equal(await checkForUpdate('0.1.0', { fetchImpl: badJson, log }), null);
  // HTTP errors: no releases yet (404), rate limited (403), GitHub down (502).
  for (const status of [404, 403, 429, 502]) {
    assert.equal(await checkForUpdate('0.1.0', { fetchImpl: fakeFetch({ message: 'x' }, status), log }), null, `HTTP ${status}`);
  }
  // No network.
  assert.equal(await checkForUpdate('0.1.0', { fetchImpl: fakeFetch(new TypeError('fetch failed')), log }), null);
  // fetch itself missing or throwing synchronously.
  assert.equal(await checkForUpdate('0.1.0', { fetchImpl: () => { throw new Error('boom'); }, log }), null);
  // Our own version unreadable: don't even ask.
  const f = fakeFetch(release());
  assert.equal(await checkForUpdate('dev', { fetchImpl: f, log }), null);
  assert.equal(f.calls.length, 0);
  assert.ok(logs.length >= 10, 'each problem was logged');
  assert.ok(logs.every(m => m.startsWith('updater: ')));
});

test('a slow GitHub times out instead of hanging', async () => {
  // A fetch that only ends when its signal aborts, like a real one would.
  const hanging = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const logs = [];
  const started = Date.now();
  assert.equal(await checkForUpdate('0.1.0', { fetchImpl: hanging, log: (m) => logs.push(m), timeoutMs: 150 }), null);
  assert.ok(Date.now() - started < 2000);
  assert.match(logs[0], /timed out/);
});

test('notes are cut to about 500 characters and links stay on our release pages', async () => {
  const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
  const u = await checkForUpdate('0.1.0', { fetchImpl: fakeFetch(release({ body: words })), log: quiet });
  assert.ok(u.notes.length <= 501, `${u.notes.length} characters`);
  assert.ok(u.notes.length > 300);
  assert.ok(u.notes.endsWith('…'));
  assert.match(u.notes, /word\d+…$/, 'cut between words');
  const empty = await checkForUpdate('0.1.0', { fetchImpl: fakeFetch(release({ body: null })), log: quiet });
  assert.equal(empty.notes, '');
  for (const html_url of ['https://evil.example/perch', 'javascript:alert(1)', 'https://github.com/Someone-Else/perch/releases/tag/v0.2.0', undefined]) {
    const r = await checkForUpdate('0.1.0', { fetchImpl: fakeFetch(release({ html_url })), log: quiet });
    assert.equal(r.url, 'https://github.com/Just-Rice/perch/releases/tag/v0.2.0', String(html_url));
  }
});

test('installUpdate starts the install script detached and lets go of it', () => {
  const spawned = [];
  let unrefs = 0;
  const spawnImpl = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    return { unref: () => { unrefs++; }, on: () => {} };
  };
  assert.deepEqual(installUpdate({ spawnImpl, log: quiet }), { started: true });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, '/bin/bash');
  assert.deepEqual(spawned[0].args, ['-c', 'curl -fsSL https://just-rice.github.io/perch/install.sh | bash -s -- --update']);
  assert.equal(INSTALL_COMMAND, spawned[0].args[1]);
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(spawned[0].opts.stdio, 'ignore');
  assert.equal(unrefs, 1);
});

test('installUpdate copes with whatever the caller hands it', () => {
  // The controller may pass {log}, the update it found, or nothing; none of that may stop it starting (only the
  // spawn is faked here, by replacing it on the options object that carries the test hook).
  const logs = [];
  const spawnImpl = () => ({ unref() {}, on() {} });
  assert.deepEqual(installUpdate({ spawnImpl, log: (m) => logs.push(m) }), { started: true });
  assert.deepEqual(logs, ['updater: update started']);
  assert.deepEqual(installUpdate({ spawnImpl, log: quiet, version: '0.2.0', url: 'x', notes: '' }), { started: true });
  // A failure to start is logged, not thrown (spawn reports it later, as an 'error' event).
  const errors = [];
  let onError;
  installUpdate({ spawnImpl: () => ({ unref() {}, on(ev, fn) { if (ev === 'error') onError = fn; } }), log: (m) => errors.push(m) });
  onError(new Error('spawn /bin/bash ENOENT'));
  assert.match(errors.at(-1), /couldn't start the update \(spawn \/bin\/bash ENOENT\)/);
});

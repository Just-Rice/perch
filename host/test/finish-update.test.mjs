// Finishing updates: an update that replaced Roost's files but couldn't restart it (the old Roost then keeps running
// an old version), automatic updates, and keeping a PC's own relay as a sign-in site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Auth } from '../src/auth.mjs';
import { Controller, IDLE_BEFORE_AUTO_MS } from '../src/controller.mjs';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

async function rig({ autoUpdate = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'roost-finish-'));
  const store = await Store.open({ home, secrets: 'file' });
  if (autoUpdate) store.updateSettings({ autoUpdate: true });
  let t = 1_000_000_000;
  const now = () => t;
  const config = {
    test: false, version: '0.3.2', appVersion: '0.3.2', origins: ['https://just-rice.github.io'],
    rpId: 'just-rice.github.io', site: 'https://just-rice.github.io/perch/connect.html',
  };
  const auth = new Auth({ store, config, log: null, now });
  const commands = [];
  const disk = { version: '0.3.2' };
  const installDirs = [];
  const installs = [];
  const latest = { release: null, checks: 0 };
  const updater = {
    installedVersion: async (dir) => { installDirs.push(dir); return disk.version; },
    checkForUpdate: async () => { latest.checks++; return latest.release; },
    installUpdate: (opts) => { installs.push(t); installDirs.push(opts?.installDir); return { started: true }; },
  };
  const rendezvous = { connectedCount: 1, status: () => [] };
  const c = new Controller({ config, store, auth, rendezvous, app: { command: (name) => commands.push(name) }, updater, now });
  c.installDir = 'C:\\Users\\Ann\\AppData\\Local\\Programs\\Roost';
  const lastActivity = () => store.config.log.at(-1)?.text ?? '';
  return {
    c, store, auth, disk, commands, installs, installDirs, latest, lastActivity,
    advance: (ms) => { t += ms; },
    done: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('nothing to finish while the copy on disk is the one running', async () => {
  const r = await rig();
  r.advance(10 * MIN);
  assert.equal(await r.c.tick(), null);
  assert.equal(r.c.state().restart, null);
  assert.equal(r.c.statusCommand().restart, undefined);
  r.done();
});

test('a newer copy on disk: offered at once, done by itself only after two quiet minutes, never under a viewer', async () => {
  const r = await rig();
  r.disk.version = '0.3.3';
  assert.equal(await r.c.tick(), null, 'Roost only just started: not straight away');
  assert.ok(r.installDirs.every(d => d === r.c.installDir), 'the VERSION file of the installed copy is read');
  assert.deepEqual(r.c.state().restart, { version: '0.3.3', running: '0.3.2', sameSigner: true, autoAfterMs: IDLE_BEFORE_AUTO_MS });
  assert.deepEqual(r.c.statusCommand().restart, { version: '0.3.3' }, 'the tray gets it too');

  // Someone connected: left alone however long it takes.
  const viewer = {};
  r.c.sessions.add(viewer);
  r.advance(30 * MIN);
  assert.equal(await r.c.tick(), null);
  r.c.sessions.delete(viewer);
  r.advance(IDLE_BEFORE_AUTO_MS / 2);
  assert.equal(await r.c.tick(), null, 'they only just left');
  assert.ok(!r.commands.includes('relaunch'));

  r.advance(IDLE_BEFORE_AUTO_MS / 2);
  assert.equal(await r.c.tick(), 'restart');
  assert.deepEqual(r.commands.filter(x => x === 'relaunch'), ['relaunch']);
  assert.match(r.lastActivity(), /restarted by itself to finish updating to 0\.3\.3/);

  // The restart didn't take (still running 0.3.2): not tried again straight away, but still offered.
  r.advance(5 * MIN);
  assert.equal(await r.c.tick(), null);
  assert.equal(r.c.state().restart.version, '0.3.3');
  r.advance(30 * MIN);
  assert.equal(await r.c.tick(), 'restart', 'tried again half an hour later');
  r.done();
});

test('Restart to Finish Updating in the tray restarts, and says why in the activity log', async () => {
  const r = await rig();
  r.disk.version = '0.3.3';
  await r.c.refreshInstalled();
  await r.c._menu('restart');
  assert.deepEqual(r.commands, ['relaunch']);
  assert.equal(r.lastActivity(), 'Roost restarted from the tray to finish updating to 0.3.3');
  r.done();
});

test('a development run (no install folder) never looks for a copy on disk', async () => {
  const r = await rig();
  r.c.installDir = null;
  r.disk.version = '0.3.3';
  r.advance(10 * MIN);
  assert.equal(await r.c.tick(), null);
  assert.equal(r.c.state().restart, null);
  assert.equal(r.installDirs.length, 0);
  r.done();
});

test('the copy on disk unreadable mid-install changes nothing', async () => {
  const r = await rig();
  r.disk.version = '0.3.3';
  await r.c.refreshInstalled();
  r.disk.version = null;
  await r.c.refreshInstalled();
  assert.equal(r.c.state().restart.version, '0.3.3');
  r.disk.version = '0.3.2';
  await r.c.refreshInstalled();
  assert.equal(r.c.state().restart, null, 'back to the running version: nothing to finish');
  r.done();
});

test('automatic updates: off by default, then only when idle, and once per version', async () => {
  const r = await rig();
  assert.equal(r.store.settings.autoUpdate, false);
  r.c.update = { version: '0.3.3', url: 'https://github.com/Just-Rice/perch/releases/tag/v0.3.3', notes: '' };
  r.advance(10 * MIN);
  assert.equal(await r.c.tick(), null, 'off: only offered');
  assert.equal(r.installs.length, 0);

  await assert.rejects(() => r.c.updateSettings({ autoUpdate: 'yes' }), /true or false/);
  await r.c.updateSettings({ autoUpdate: true });
  assert.match(r.lastActivity(), /Automatic updates turned on/);
  r.c.guests.add({});
  assert.equal(await r.c.tick(), null, 'a guest is watching');
  r.c.guests.clear();
  r.advance(IDLE_BEFORE_AUTO_MS);
  assert.equal(await r.c.tick(), 'update');
  assert.equal(r.installs.length, 1);
  assert.match(r.lastActivity(), /Updating by itself to Roost 0\.3\.3/);
  assert.equal(r.installDirs.at(-1), r.c.installDir, 'the install script is looked for in the install folder');
  r.advance(10 * MIN);
  assert.equal(await r.c.tick(), null, 'not again for the same version straight away');
  assert.equal(r.installs.length, 1);
  r.done();
});

test('new releases are looked for daily, or every six hours with automatic updates on', async () => {
  const r = await rig();
  r.c.lastUpdateCheckAt = 0; // as if main.mjs's first check had run
  r.advance(0);
  const checksAfter = async (ms) => { r.advance(ms); await r.c.tick(); return r.latest.checks; };
  r.c.lastUpdateCheckAt = r.c.now();
  assert.equal(await checksAfter(7 * HOUR), 0);
  assert.equal(await checksAfter(17 * HOUR), 1, 'a day on');
  await r.c.updateSettings({ autoUpdate: true });
  r.latest.release = { version: '0.3.3', url: '', notes: '' };
  assert.equal(await checksAfter(6 * HOUR), 2, 'six hours on');
  assert.equal(r.c.update.version, '0.3.3');
  r.done();
});

test('a PC whose own relay was set up before 0.3.2 keeps accepting sign-ins there, once', async () => {
  const r = await rig();
  const base = 'https://perch-relay.someone.workers.dev';
  await r.store.setWorkerRelay({ url: base, secret: 'x'.repeat(43) });
  assert.equal(r.auth.siteFor(base), null, 'saved before Roost made it a sign-in site');
  r.c._keepOwnRelaySite();
  assert.equal(r.auth.siteFor(base)?.origin, base);
  assert.equal(r.auth.siteFor(base).builtIn, false, 'this PC only, and removable');
  assert.match(r.lastActivity(), /still accepted from https:\/\/perch-relay\.someone\.workers\.dev/);
  // Removed by the owner later: it stays removed.
  r.store.removeSite(base);
  r.c._keepOwnRelaySite();
  assert.equal(r.auth.siteFor(base), null);
  r.done();
});

test('without a relay of its own a PC gets no extra sign-in site', async () => {
  const r = await rig();
  r.c._keepOwnRelaySite();
  assert.deepEqual(r.auth.sites().map(x => x.origin), ['https://just-rice.github.io']);
  r.done();
});

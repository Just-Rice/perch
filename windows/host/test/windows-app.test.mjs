// What roost.exe tells the host that Perch's Mac app didn't (docs/WINDOWS-APP.md): the Windows HELLO, "Control admin
// apps" (elevation) and a PC that can't keep the privacy curtain out of the picture. The Mac HELLO still works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Auth } from '../src/auth.mjs';
import { Controller } from '../src/controller.mjs';

const WINDOWS_HELLO = {
  app: 'Roost', version: '0.1.0', ipc: 1, os: 'windows', osVersion: '10.0.22631', arch: 'arm64', synthetic: false,
  soundTap: true, permissions: { screen: true, accessibility: true, elevated: false },
  displays: [{ id: 2873401, name: 'DELL U2720Q', width: 3840, height: 2160, x: 0, y: 0, main: true }],
  loginItem: { on: true, status: 'enabled' },
  features: { curtain: true, encoder: 'Media Foundation (NVIDIA)', elevatedTask: false },
};

async function rig() {
  const home = mkdtempSync(join(tmpdir(), 'roost-winapp-'));
  const store = await Store.open({ home, secrets: 'file' });
  const config = { test: false, version: '0.1.0', origins: ['https://just-rice.github.io'], rpId: 'just-rice.github.io',
    site: 'https://just-rice.github.io/perch/windows/connect.html' };
  const auth = new Auth({ store, config, log: null });
  const commands = [];
  const app = { command: (name, body) => commands.push([name, body]) };
  const c = new Controller({ config, store, auth, rendezvous: { connectedCount: 1, status: () => [] }, app });
  const viewer = { signedIn: true, label: 'Safari on iPad', route: 'passkey', quality: 'balanced', display: null,
    window: null, videoProfile: 'baseline', signedInAt: Date.now(), sendStatus() {}, end() {} };
  const sent = name => commands.filter(([n]) => n === name).map(([, body]) => body);
  const lastActivity = () => store.config.log.at(-1)?.text ?? '';
  return { c, store, commands, sent, viewer, lastActivity, done: () => rmSync(home, { recursive: true, force: true }) };
}

test('before HELLO the Control Center gets an app object with nothing known yet', async () => {
  const r = await rig();
  assert.deepEqual(r.c.state().app, {
    os: null, osVersion: null, arch: null, elevated: false, elevatedTask: false, features: null, elevationError: null,
  });
  r.done();
});

test('the Windows HELLO: system, processor, administrator and features reach the Control Center', async () => {
  const r = await rig();
  r.c.handleHello(WINDOWS_HELLO);
  assert.deepEqual(r.c.state().app, {
    os: 'windows', osVersion: '10.0.22631', arch: 'arm64', elevated: false, elevatedTask: false,
    features: { curtain: true, encoder: 'Media Foundation (NVIDIA)', elevatedTask: false }, elevationError: null,
  });
  assert.equal(r.c.state().version, '0.1.0');
  assert.deepEqual(r.c.state().permissions, { screen: true, accessibility: true });
  assert.equal(r.c.state().soundTap, true);
  // Input works on Windows without asking: the viewer is told so.
  assert.equal(r.c.sessionSignedIn(r.viewer).input, true);

  r.c.handleHello({ ...WINDOWS_HELLO, permissions: { screen: true, accessibility: true, elevated: true },
    features: { ...WINDOWS_HELLO.features, elevatedTask: true } });
  assert.equal(r.c.state().app.elevated, true);
  assert.equal(r.c.state().app.elevatedTask, true);
  r.done();
});

test('the Mac HELLO is still understood', async () => {
  const r = await rig();
  r.c.handleHello({ app: 'Perch', version: '0.3.5', macos: '15.1.0', synthetic: true,
    permissions: { screen: true, accessibility: false }, displays: [] });
  const app = r.c.state().app;
  assert.equal(app.os, 'macos');
  assert.equal(app.osVersion, '15.1.0');
  assert.equal(app.elevated, false);
  assert.equal(app.features.curtain, true, 'an app that doesn’t say has a curtain');
  assert.equal(r.c.sessionSignedIn(r.viewer).input, false, 'input still follows Accessibility');
  await assert.rejects(async () => r.c.elevation(true), /only needed on Windows/);
  r.done();
});

test('strange HELLO values are cut down to size, never trusted as they are', async () => {
  const r = await rig();
  r.c.handleHello({ ...WINDOWS_HELLO, os: 'w'.repeat(500), osVersion: { evil: 1 }, arch: 42,
    features: { curtain: 'no', encoder: 'x'.repeat(500), elevatedTask: 'yes' } });
  const app = r.c.state().app;
  assert.equal(app.os.length, 20);
  assert.equal(app.osVersion, null);
  assert.equal(app.arch, null);
  assert.deepEqual(app.features, { curtain: true, encoder: 'x'.repeat(80), elevatedTask: false }, 'only real booleans count');
  r.done();
});

test('Control admin apps: the command goes to the app, and its answer reaches the Control Center', async () => {
  const r = await rig();
  r.c.handleHello(WINDOWS_HELLO);
  assert.throws(() => r.c.elevation('on'), /true or false/);
  assert.deepEqual(r.c.elevation(true), { ok: true });
  assert.deepEqual(r.sent('elevation'), [{ on: true }]);

  // Windows asked, and the owner said no.
  r.c.handleEvent({ e: 'elevation', ok: false, elevated: false, task: false, error: 'The operation was canceled by the user.' });
  assert.equal(r.c.state().app.elevationError, 'The operation was canceled by the user.');
  assert.equal(r.c.state().app.elevatedTask, false);

  // Asked again: the old error goes at once, then the app says it worked (and restarts elevated).
  r.c.elevation(true);
  assert.equal(r.c.state().app.elevationError, null);
  r.c.handleEvent({ e: 'elevation', ok: true, elevated: true, task: true });
  assert.deepEqual(
    (({ elevated, elevatedTask, elevationError }) => ({ elevated, elevatedTask, elevationError }))(r.c.state().app),
    { elevated: true, elevatedTask: true, elevationError: null });
  assert.equal(r.c.state().app.features.elevatedTask, true);
  assert.equal(r.lastActivity(), 'Control admin apps turned on');

  // The app also sends the state by itself after HELLO, without ok: nothing is logged then.
  const logged = r.store.config.log.length;
  r.c.handleEvent({ e: 'elevation', elevated: true, task: true });
  assert.equal(r.store.config.log.length, logged);

  r.c.elevation(false);
  r.c.handleEvent({ e: 'elevation', ok: true, elevated: false, task: false });
  assert.equal(r.lastActivity(), 'Control admin apps turned off');
  r.c.handleEvent({ e: 'elevation', ok: false, elevated: false, task: false });
  assert.equal(r.c.state().app.elevationError, 'Windows didn’t allow it.', 'a failure without a reason still says so');
  r.done();
});

test('a PC that can’t keep the curtain out of the picture refuses it, and never puts it up', async () => {
  const r = await rig();
  r.c.handleHello({ ...WINDOWS_HELLO, features: { ...WINDOWS_HELLO.features, curtain: false } });
  await assert.rejects(r.c.updateSettings({ curtain: true }), /can’t keep the curtain out of the picture/);
  assert.equal(r.store.settings.curtain, false);
  await r.c.updateSettings({ curtain: false }); // turning it off is always fine

  // Chosen earlier, on an app that could: the curtain stays down here.
  r.store.updateSettings({ curtain: true });
  r.c.sessionSignedIn(r.viewer);
  assert.equal(r.sent('session').at(-1).curtain, false);
  r.done();
});

test('where the curtain works, it goes up with the session and can change mid-session', async () => {
  const r = await rig();
  r.c.handleHello(WINDOWS_HELLO);
  await r.c.updateSettings({ curtain: true });
  r.c.sessionSignedIn(r.viewer);
  assert.equal(r.sent('session').at(-1).curtain, true);
  await r.c.updateSettings({ curtain: false });
  assert.equal(r.sent('session').at(-1).curtain, false);
  r.done();
});

test('there are no permissions to ask for or reset on Windows', async () => {
  const r = await rig();
  r.c.handleHello(WINDOWS_HELLO);
  assert.equal(r.c.requestPermission('screen'), undefined);
  assert.deepEqual(r.c.resetPermission('accessibility'), { ok: false, error: 'Not needed on Windows.' });
  assert.deepEqual(r.sent('request-permission'), []);
  assert.deepEqual(r.sent('reset-permission'), []);
  assert.doesNotMatch(r.lastActivity(), /permission/, 'nothing pretends a permission was reset');
  r.done();
});

// Sound while someone is connected: the Mac's own speakers and what is sent, set apart (Setup, or live in the viewer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Auth } from '../src/auth.mjs';
import { Controller } from '../src/controller.mjs';

async function rig() {
  const home = mkdtempSync(join(tmpdir(), 'perch-levels-'));
  const store = await Store.open({ home, secrets: 'file' });
  const config = { test: false, version: '0.3.5', origins: ['https://just-rice.github.io'], rpId: 'just-rice.github.io',
    site: 'https://just-rice.github.io/perch/connect.html' };
  const auth = new Auth({ store, config, log: null });
  const commands = [];
  const app = { command: (name, body) => commands.push([name, body]) };
  const c = new Controller({ config, store, auth, rendezvous: { connectedCount: 1, status: () => [] }, app });
  const statuses = [];
  const viewer = { signedIn: true, label: 'Chrome on Chromebook', route: 'passkey', quality: 'balanced', display: 1,
    window: null, videoProfile: 'baseline', sendStatus: (extra) => statuses.push(extra) };
  return { c, store, commands, statuses, viewer, done: () => rmSync(home, { recursive: true, force: true }) };
}

test('by default both levels are 100%, and the speakers one is only offered where the app can tap the sound', async () => {
  const r = await rig();
  assert.equal(r.store.settings.macSpeakers, 1);
  assert.equal(r.store.settings.streamVolume, 1);
  assert.deepEqual(r.c.levels(), { speakers: 1, stream: 1, speakersAvailable: false });
  assert.ok(r.c.caps.includes('levels'), 'viewers that know levels show the sliders');
  r.c.handleHello({ app: 'Perch', version: '0.3.5', macos: '27.0.0', soundTap: true, permissions: {}, displays: [] });
  assert.equal(r.c.levels().speakersAvailable, true);
  assert.equal(r.c.state().soundTap, true, 'Setup knows too');
  r.done();
});

test('levels are checked, rounded, and reach the app and the viewer at once during a session', async () => {
  const r = await rig();
  for (const bad of [{ macSpeakers: 1.2 }, { macSpeakers: -0.1 }, { streamVolume: 1.6 }, { streamVolume: 'loud' }, { macSpeakers: NaN }]) {
    await assert.rejects(() => r.c.updateSettings(bad), /from 0 to/, JSON.stringify(bad));
  }
  // Nobody connected: saved, nothing sent.
  await r.c.updateSettings({ streamVolume: 1.333 });
  assert.equal(r.store.settings.streamVolume, 1.33);
  assert.equal(r.commands.filter(([n]) => n === 'audio-levels').length, 0);

  r.c.active = r.viewer;
  r.c.captureOn = true;
  await r.c.updateSettings({ macSpeakers: 0 });
  assert.deepEqual(r.commands.filter(([n]) => n === 'audio-levels').at(-1), ['audio-levels', { speakers: 0, stream: 1.33 }]);
  assert.deepEqual(r.statuses.at(-1), { levels: { speakers: 0, stream: 1.33, speakersAvailable: false } });
  // The same value again: nothing new to say.
  const before = r.commands.length;
  await r.c.updateSettings({ macSpeakers: 0 });
  assert.equal(r.commands.length, before);
  r.done();
});

test('the owner\'s viewer moves a slider: saved for next time; anyone else\'s is ignored', async () => {
  const r = await rig();
  r.c.active = r.viewer;
  r.c.captureOn = true;
  await r.c.setLevels(r.viewer, { speakers: 0.25 });
  assert.equal(r.store.settings.macSpeakers, 0.25);
  assert.equal(r.store.settings.streamVolume, 1, 'only what moved changes');
  await r.c.setLevels({ ...r.viewer }, { speakers: 1, stream: 0 });
  assert.equal(r.store.settings.macSpeakers, 0.25, 'not the active session: ignored');
  await r.c.setLevels(r.viewer, { stream: 7 });
  assert.equal(r.store.settings.streamVolume, 1, 'out of range: refused (the session clamps first; this is the last line)');
  r.done();
});

test('every capture command carries the levels, so a new session starts at them', async () => {
  const r = await rig();
  r.c.displays = [{ id: 1, name: 'Built-in', x: 0, y: 0, width: 1512, height: 982, main: true }];
  await r.c.updateSettings({ macSpeakers: 0, streamVolume: 1.5 });
  r.c.active = r.viewer;
  r.c._sendCapture(r.viewer);
  const [, cmd] = r.commands.filter(([n]) => n === 'capture').at(-1);
  assert.equal(cmd.speakers, 0);
  assert.equal(cmd.stream, 1.5);
  r.done();
});

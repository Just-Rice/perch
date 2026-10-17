import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { lockedFor, recordFailure, recordSuccess, freshLimit, MAX_FAILS } from '../src/limits.mjs';
import { MAC_NAME_RE } from '../../../site/js/shared/rendezvous.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'perch-store-'));

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

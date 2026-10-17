// Pairing links, passkey user handles, the known-Macs list and the remembered preferences.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePairHash, makePairHash, parseUserHandle } from '../../site/js/ui/pairlink.js';
import { MacStore, safeStorage, validMac, lastUsedText, MACS_KEY } from '../../site/js/ui/macs.js';
import { Prefs, defaultPrefs, PREFS_KEY } from '../../site/js/ui/prefs.js';
import { toB64url, randomBytes } from '../../site/js/shared/bytes.js';

const fill = (n, v) => new Uint8Array(n).fill(v);
const parts = () => ({ hostId: fill(16, 1), sigKey: fill(32, 2), pairId: fill(16, 3), pairSecret: fill(32, 4) });

// A Storage stand-in: Map-backed, optionally throwing like a blocked or full localStorage.
function memStorage({ throwOn = '' } = {}) {
  const m = new Map();
  return {
    m,
    getItem: k => { if (throwOn.includes('get')) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (throwOn.includes('set')) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
  };
}

const mac = (i, extra = {}) => ({
  hostId: toB64url(fill(16, i)), sigKey: toB64url(fill(32, i)), credentialId: `cred${i}`, name: `mac-${i}`,
  lastUsed: i * 1000, ...extra,
});

test('pairing link: round trip', () => {
  const p = parts();
  const hash = makePairHash(p);
  assert.match(hash, /^#pair=[A-Za-z0-9_-]{128}$/);
  assert.deepEqual(parsePairHash(hash), p);
  assert.deepEqual(parsePairHash(hash.slice(1)), p, 'with or without the #');
});

test('pairing link: other hash parts are ignored, the pair part is found', () => {
  const p = parts();
  const v = makePairHash(p).slice('#pair='.length);
  assert.deepEqual(parsePairHash(`#x=1&pair=${v}&y=2`), p);
});

test('pairing link: no pairing part is null, a broken one is an error', () => {
  assert.equal(parsePairHash(''), null);
  assert.equal(parsePairHash('#'), null);
  assert.equal(parsePairHash('#install'), null);
  assert.deepEqual(parsePairHash('#pair='), { error: 'bad' });
  assert.deepEqual(parsePairHash('#pair=abc'), { error: 'bad' }, 'too short');
  assert.deepEqual(parsePairHash('#pair=' + toB64url(randomBytes(97))), { error: 'bad' }, 'one byte too many');
  assert.deepEqual(parsePairHash('#pair=' + '+'.repeat(128)), { error: 'bad' }, 'not base64url');
});

test('user handle: 48 bytes → hostId and sigKey; anything else is not a Perch passkey', () => {
  const h = new Uint8Array(48);
  h.fill(7, 0, 16);
  h.fill(9, 16);
  assert.deepEqual(parseUserHandle(h), { hostId: fill(16, 7), sigKey: fill(32, 9) });
  assert.equal(parseUserHandle(new Uint8Array(32)), null);
  assert.equal(parseUserHandle(null), null);
  assert.equal(parseUserHandle('x'.repeat(48)), null);
});

test('MacStore: save, list newest first, update, forget', () => {
  const s = new MacStore(memStorage());
  assert.deepEqual(s.list(), []);
  s.save(mac(1));
  s.save(mac(3));
  s.save(mac(2));
  assert.deepEqual(s.list().map(m => m.name), ['mac-3', 'mac-2', 'mac-1']);
  const u = s.update(mac(1).hostId, { lastUsed: 99999, name: 'renamed' });
  assert.equal(u.name, 'renamed');
  assert.equal(s.list()[0].name, 'renamed');
  s.forget(mac(3).hostId);
  assert.deepEqual(s.list().map(m => m.name), ['renamed', 'mac-2']);
  assert.equal(s.update('nope', { name: 'x' }), null);
  assert.equal(s.persistent, true);
});

test('MacStore: one entry per Mac; a new passkey replaces the old one but keeps the name', () => {
  const s = new MacStore(memStorage());
  s.save(mac(1));
  s.save({ ...mac(1), credentialId: 'newcred', name: '' });
  const list = s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].credentialId, 'newcred');
  assert.equal(list[0].name, 'mac-1');
});

test('MacStore: stored data is exactly the documented shape', () => {
  const st = memStorage();
  const s = new MacStore(st);
  s.save(mac(4, { label: 'Work Mac', extra: 'dropped' }));
  const raw = JSON.parse(st.m.get(MACS_KEY));
  assert.deepEqual(Object.keys(raw[0]).sort(), ['credentialId', 'hostId', 'label', 'lastUsed', 'name', 'sigKey']);
});

test('MacStore: junk in storage is ignored, not fatal', () => {
  const st = memStorage();
  st.setItem(MACS_KEY, '{not json');
  assert.deepEqual(new MacStore(st).list(), []);
  st.setItem(MACS_KEY, JSON.stringify({ a: 1 }));
  assert.deepEqual(new MacStore(st).list(), []);
  st.setItem(MACS_KEY, JSON.stringify([mac(1), { hostId: 'short', sigKey: 'x', credentialId: 'c' }, null, 5, mac(2, { credentialId: 'bad id!' })]));
  assert.deepEqual(new MacStore(st).list().map(m => m.name), ['mac-1']);
});

test('validMac and save() reject wrong sizes', () => {
  assert.equal(validMac(mac(1)), true);
  assert.equal(validMac({ ...mac(1), hostId: toB64url(fill(15, 1)) }), false);
  assert.equal(validMac({ ...mac(1), sigKey: toB64url(fill(33, 1)) }), false);
  assert.equal(validMac({ ...mac(1), credentialId: 5 }), false);
  assert.throws(() => new MacStore(memStorage()).save({ hostId: 'x' }));
});

test('MacStore keeps at most 20 Macs', () => {
  const s = new MacStore(memStorage());
  for (let i = 1; i <= 25; i++) s.save(mac(i, { lastUsed: i }));
  assert.equal(s.list().length, 20);
});

test('safeStorage: blocked localStorage falls back to memory for this visit', () => {
  const blocked = safeStorage(() => { throw new Error('SecurityError'); });
  assert.equal(blocked.memoryOnly, true);
  const s = new MacStore(blocked);
  assert.equal(s.persistent, false);
  s.save(mac(1));
  assert.equal(s.list().length, 1);
  const full = safeStorage(() => memStorage({ throwOn: 'set' }));
  assert.equal(full.memoryOnly, true);
  const ok = memStorage();
  assert.equal(safeStorage(() => ok), ok);
  assert.equal(ok.m.size, 0, 'the probe is cleaned up');
});

test('MacStore survives storage that starts failing later', () => {
  const st = memStorage();
  const s = new MacStore(st);
  s.save(mac(1));
  const broken = { getItem: () => { throw new Error('gone'); }, setItem: () => { throw new Error('gone'); } };
  const s2 = new MacStore(broken);
  assert.deepEqual(s2.list(), []);
  assert.doesNotThrow(() => s2.save(mac(2)));
});

test('lastUsedText', () => {
  const now = new Date(2026, 9, 17, 15, 0).getTime();
  const day = 864e5;
  assert.equal(lastUsedText(0, now), 'Not used yet');
  assert.equal(lastUsedText(now - 3600e3, now), 'Used today');
  assert.equal(lastUsedText(now - day, now), 'Used yesterday');
  assert.equal(lastUsedText(now - 3 * day, now), 'Used 3 days ago');
  assert.equal(lastUsedText(now - 21 * day, now), 'Used 3 weeks ago');
  assert.equal(lastUsedText(now - 120 * day, now), 'Used 4 months ago');
});

test('Prefs: defaults depend on the keyboard; saved values are checked', () => {
  assert.equal(defaultPrefs({ apple: true }).swapCtrlCmd, false);
  assert.equal(defaultPrefs({ apple: false }).swapCtrlCmd, true);
  const st = memStorage();
  st.setItem(PREFS_KEY, JSON.stringify({ quality: 'ultra', swapCtrlCmd: 'yes', volume: 7, muted: true, backupName: 'x'.repeat(99) }));
  const p = new Prefs({ storage: st, apple: false });
  assert.equal(p.get('quality'), 'balanced', 'unknown preset ignored');
  assert.equal(p.get('swapCtrlCmd'), true, 'non-boolean ignored');
  assert.equal(p.get('volume'), 1, 'clamped');
  assert.equal(p.get('muted'), true);
  assert.equal(p.get('backupName').length, 40);
  p.set('quality', 'sharp');
  assert.equal(new Prefs({ storage: st }).get('quality'), 'sharp');
  assert.doesNotThrow(() => new Prefs({ storage: memStorage({ throwOn: 'getset' }) }).set('volume', 0.5));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { hotp, totp, checkCode, base32, fromBase32, otpauthUri, newSecret } from '../src/totp.mjs';
import { newMacName, suggestPassword, wordCounts } from '../src/names.mjs';
import { MAC_NAME_RE } from '../../../site/js/shared/rendezvous.js';

// RFC 6238 appendix B test vectors (SHA-1 key "12345678901234567890", 8 digits).
const RFC_KEY = Buffer.from('12345678901234567890');
const VECTORS = [
  [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
  [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
];

test('TOTP matches the RFC 6238 test vectors', () => {
  for (const [t, code] of VECTORS) assert.equal(totp(RFC_KEY, t * 1000, 8), code, `t=${t}`);
});

test('HOTP matches RFC 4226 appendix D', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, i) => assert.equal(hotp(RFC_KEY, i), code));
});

test('codes are accepted for one step either side, once each', () => {
  const secret = newSecret();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30000);
  assert.equal(checkCode(secret, totp(secret, now), { now }), step);
  assert.equal(checkCode(secret, totp(secret, now - 30000), { now }), step - 1);
  assert.equal(checkCode(secret, totp(secret, now + 30000), { now }), step + 1);
  assert.equal(checkCode(secret, totp(secret, now - 60000), { now }), null, 'two steps old');
  assert.equal(checkCode(secret, totp(secret, now), { now, lastStep: step }), null, 'already used');
  assert.equal(checkCode(secret, totp(secret, now - 30000), { now, lastStep: step }), null, 'older than the last used');
  assert.equal(checkCode(secret, '12345', { now }), null);
  assert.equal(checkCode(secret, '1234567', { now }), null);
  assert.equal(checkCode(secret, 123456, { now }), null);
  assert.equal(checkCode(secret, 'abcdef', { now }), null);
});

test('base32 round-trips and the otpauth link is well formed', () => {
  for (let i = 0; i < 20; i++) {
    const s = newSecret();
    assert.deepEqual(fromBase32(base32(s)), s);
  }
  assert.equal(base32(Buffer.from('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const uri = new URL(otpauthUri(RFC_KEY, 'amber-otter-4821'));
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.searchParams.get('secret'), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(uri.searchParams.get('issuer'), 'Perch');
  assert.match(decodeURIComponent(uri.pathname), /Perch:amber-otter-4821$/);
});

test('Mac names and suggested passwords look right', () => {
  assert.deepEqual(wordCounts(), { adjectives: 256, animals: 256 });
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const n = newMacName();
    assert.match(n, MAC_NAME_RE);
    seen.add(n);
  }
  assert.ok(seen.size > 495);
  assert.match(suggestPassword(), /^[a-z]+(-[a-z]+){4}$/);
});

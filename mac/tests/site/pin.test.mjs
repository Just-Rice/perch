// The Mac's certificate pin: carried by pairing links and passkey handles, checked against every offer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePairHash, makePairHash, parseUserHandle } from '../../site/js/ui/pairlink.js';
import { offerMatchesPin } from '../../site/js/ui/quick.js';
import { fingerprintBytes } from '../../site/js/shared/bind.js';
import { randomBytes } from '../../site/js/shared/bytes.js';

const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
const sdp = fp => `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${fp}\r\n`;

test('an offer matches the pin only when it is signed for by the pinned certificate', () => {
  const pin = fingerprintBytes(`sha-256 ${FP}`);
  assert.equal(offerMatchesPin(sdp(FP), pin), true);
  assert.equal(offerMatchesPin(sdp(FP.toLowerCase()), pin), true, 'case does not matter');
  const other = FP.replace(/^00/, 'FF');
  assert.equal(offerMatchesPin(sdp(other), pin), false, 'an impostor with another certificate');
  assert.equal(offerMatchesPin(sdp(FP) + `a=fingerprint:sha-256 ${other}\r\n`, pin), false, 'a second certificate slipped in');
  assert.equal(offerMatchesPin('v=0\r\n', pin), false, 'no certificate at all');
});

test('pairing links and passkey handles carry the pin when the Mac has one, and still read without', () => {
  const link = { hostId: randomBytes(16), sigKey: randomBytes(32), pairId: randomBytes(16), pairSecret: randomBytes(32) };
  const pin = randomBytes(16);
  assert.deepEqual(parsePairHash(makePairHash({ ...link, pin })), { ...link, pin });
  const old = parsePairHash(makePairHash(link));
  assert.deepEqual(old, link);
  assert.equal('pin' in old, false);
  assert.deepEqual(parsePairHash('#pair=' + 'A'.repeat(20)), { error: 'bad' });
  const handle = new Uint8Array([...link.hostId, ...link.sigKey, ...pin]);
  assert.deepEqual(parseUserHandle(handle), { hostId: link.hostId, sigKey: link.sigKey, pin });
  assert.deepEqual(parseUserHandle(handle.subarray(0, 48)), { hostId: link.hostId, sigKey: link.sigKey });
  assert.equal(parseUserHandle(handle.subarray(0, 50)), null);
});

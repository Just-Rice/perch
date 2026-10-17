// Pairing links and passkey user handles carry a Mac's address as raw bytes.
//   pairing link: connect.html#pair=<b64url(hostId ‖ sigKey ‖ pairId ‖ pairSecret)>   (docs/PROTOCOL.md, "Setup page")
//   user handle:  hostId ‖ sigKey                                                    (docs/PROTOCOL.md, "Identities")
import { fromB64url, toB64url } from '../shared/bytes.js';
import { HOST_ID_BYTES, SIG_KEY_BYTES, PAIR_ID_BYTES, PAIR_SECRET_BYTES } from '../shared/proto.js';

const PAIR_BYTES = HOST_ID_BYTES + SIG_KEY_BYTES + PAIR_ID_BYTES + PAIR_SECRET_BYTES;

// Returns null when the hash has no pairing part, {error} when it has a broken one, otherwise the four parts.
export function parsePairHash(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h) return null;
  let value = null;
  for (const part of h.split('&')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === 'pair') value = part.slice(i + 1);
  }
  if (value === null) return null;
  let bytes;
  try { bytes = fromB64url(value.trim()); } catch { return { error: 'bad' }; }
  if (bytes.length !== PAIR_BYTES) return { error: 'bad' };
  let o = 0;
  const take = n => bytes.slice(o, (o += n));
  return { hostId: take(HOST_ID_BYTES), sigKey: take(SIG_KEY_BYTES), pairId: take(PAIR_ID_BYTES), pairSecret: take(PAIR_SECRET_BYTES) };
}

export function makePairHash({ hostId, sigKey, pairId, pairSecret }) {
  const all = new Uint8Array(PAIR_BYTES);
  all.set(hostId, 0);
  all.set(sigKey, HOST_ID_BYTES);
  all.set(pairId, HOST_ID_BYTES + SIG_KEY_BYTES);
  all.set(pairSecret, HOST_ID_BYTES + SIG_KEY_BYTES + PAIR_ID_BYTES);
  return '#pair=' + toB64url(all);
}

// A passkey's user handle → {hostId, sigKey}, or null for a passkey that isn't Perch's.
export function parseUserHandle(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== HOST_ID_BYTES + SIG_KEY_BYTES) return null;
  return { hostId: bytes.slice(0, HOST_ID_BYTES), sigKey: bytes.slice(HOST_ID_BYTES) };
}

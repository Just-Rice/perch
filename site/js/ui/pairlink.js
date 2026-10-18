// Pairing links and passkey user handles carry a Mac's address as raw bytes, and (newer Macs) a pin: the first 16
// bytes of the Mac's fixed DTLS certificate fingerprint, so the browser can tell the real Mac from an impostor.
//   pairing link: connect.html#pair=<b64url(hostId ‖ sigKey ‖ pairId ‖ pairSecret [‖ pin])>  (docs/PROTOCOL.md)
//   user handle:  hostId ‖ sigKey [‖ pin]                                                   (docs/PROTOCOL.md)
import { fromB64url, toB64url } from '../shared/bytes.js';
import { HOST_ID_BYTES, SIG_KEY_BYTES, PAIR_ID_BYTES, PAIR_SECRET_BYTES } from '../shared/proto.js';

const PAIR_BYTES = HOST_ID_BYTES + SIG_KEY_BYTES + PAIR_ID_BYTES + PAIR_SECRET_BYTES;
export const PIN_BYTES = 16;

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
  if (bytes.length !== PAIR_BYTES && bytes.length !== PAIR_BYTES + PIN_BYTES) return { error: 'bad' };
  let o = 0;
  const take = n => bytes.slice(o, (o += n));
  const link = { hostId: take(HOST_ID_BYTES), sigKey: take(SIG_KEY_BYTES), pairId: take(PAIR_ID_BYTES), pairSecret: take(PAIR_SECRET_BYTES) };
  if (bytes.length > PAIR_BYTES) link.pin = take(PIN_BYTES);
  return link;
}

export function makePairHash({ hostId, sigKey, pairId, pairSecret, pin = null }) {
  const all = new Uint8Array(PAIR_BYTES + (pin ? PIN_BYTES : 0));
  if (pin) all.set(pin, PAIR_BYTES);
  all.set(hostId, 0);
  all.set(sigKey, HOST_ID_BYTES);
  all.set(pairId, HOST_ID_BYTES + SIG_KEY_BYTES);
  all.set(pairSecret, HOST_ID_BYTES + SIG_KEY_BYTES + PAIR_ID_BYTES);
  return '#pair=' + toB64url(all);
}

// A passkey's user handle → {hostId, sigKey, pin?}, or null for a passkey that isn't Perch's.
export function parseUserHandle(bytes) {
  const base = HOST_ID_BYTES + SIG_KEY_BYTES;
  if (!(bytes instanceof Uint8Array) || (bytes.length !== base && bytes.length !== base + PIN_BYTES)) return null;
  return {
    hostId: bytes.slice(0, HOST_ID_BYTES), sigKey: bytes.slice(HOST_ID_BYTES, base),
    ...(bytes.length > base ? { pin: bytes.slice(base) } : {}),
  };
}

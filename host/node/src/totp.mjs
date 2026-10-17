// Authenticator app codes (TOTP, RFC 6238): HMAC-SHA1, 6 digits, 30-second steps — what every authenticator app
// uses by default. The Mac accepts the previous, current and next step, and each step only once.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const STEP_SECONDS = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newSecret() {
  return randomBytes(20);
}

export function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('bad base32');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secret, counter, digits = 6, algo = 'sha1') {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algo, secret).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);

export function totp(secret, ms = Date.now(), digits = 6, algo = 'sha1') {
  return hotp(secret, stepAt(ms), digits, algo);
}

// Returns the matching step number, or null. `lastStep` is the newest step already used (or -1).
export function checkCode(secret, code, { now = Date.now(), lastStep = -1, window = 1 } = {}) {
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return null;
  const current = stepAt(now);
  let found = null;
  for (let s = current - window; s <= current + window; s++) {
    const expected = Buffer.from(hotp(secret, s));
    // Check every step (no early exit) so timing doesn't reveal which one matched.
    if (timingSafeEqual(expected, Buffer.from(code)) && s > lastStep && found === null) found = s;
  }
  return found;
}

export function otpauthUri(secret, macName) {
  const label = encodeURIComponent(`Perch:${macName}`);
  return `otpauth://totp/${label}?secret=${base32(secret)}&issuer=Perch&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

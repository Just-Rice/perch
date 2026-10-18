// Channel binding: ties a sign-in to one exact WebRTC connection.
//
// Each side hashes the offer and answer SDP *exactly as it sent or received them*. The SDP carries the DTLS
// certificate fingerprints that WebRTC checks during the encrypted handshake, so if anything in the middle
// (a rendezvous broker, a network attacker) swapped an SDP to insert itself, the two sides compute different
// binding values and every proof below fails. Passkey challenges, pairing proofs and the backup sign-in's key
// confirmation are all made over this value. See docs/PROTOCOL.md, "Binding".
import { utf8 } from './bytes.js';
import { sha256, hmacSha256 } from './crypto.js';

export async function bindingHash(nonce, offerSdp, answerSdp) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new Error('binding nonce must be 32 bytes');
  if (typeof offerSdp !== 'string' || typeof answerSdp !== 'string') throw new Error('binding needs both SDPs');
  return sha256(utf8('perch bind v1'), nonce, await sha256(utf8(offerSdp)), await sha256(utf8(answerSdp)));
}

// A proof that whoever holds `key` is on this connection. `label` keeps proofs for different purposes apart.
export function bindProof(key, label, bind) {
  return hmacSha256(key, utf8(`perch ${label} v1`), bind);
}

// --- one-tap sign-in ("quick"): the passkey is asked for before connecting, so it can't sign the Mac's nonce ---
//
// The browser makes its WebRTC certificate first and signs SHA-256("perch quick v1" ‖ r ‖ ts ‖ its fingerprint), with
// a fresh 16-byte r and the time. The passkey's user handle also carries the first 16 bytes of the Mac's own (fixed)
// DTLS certificate fingerprint, so the browser only ever sends that assertion over a connection whose other end proves
// it holds that certificate, i.e. the real Mac. The Mac checks the signed fingerprint is the one in the answer it
// received, that ts is recent and that r is new. See docs/PROTOCOL.md, "One-tap sign-in".

export const QUICK_MAX_AGE_MS = 3 * 60 * 1000;

export async function quickChallenge(r, ts, fingerprint) {
  if (!(r instanceof Uint8Array) || r.length !== 16) throw new Error('quick r must be 16 bytes');
  if (!Number.isSafeInteger(ts) || ts < 0) throw new Error('quick ts must be a time in ms');
  if (typeof fingerprint !== 'string' || !fingerprint.startsWith('sha-256 ')) throw new Error('quick needs a sha-256 fingerprint');
  const t = new Uint8Array(8);
  new DataView(t.buffer).setBigUint64(0, BigInt(ts));
  return sha256(utf8('perch quick v1'), r, t, utf8(fingerprint));
}

// The one certificate fingerprint an SDP announces, as "sha-256 AB:CD:…", or null unless every fingerprint line is
// sha-256 and they all name the same certificate (browsers use one certificate for every m-line). Anything else
// could let a second certificate slip in beside the signed one.
export function sdpFingerprint(sdp) {
  if (typeof sdp !== 'string') return null;
  const seen = new Set();
  for (const m of sdp.matchAll(/^a=fingerprint:(.*)$/gm)) {
    const f = /^(\S+) ([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31})\s*$/.exec(m[1]);
    if (!f || f[1].toLowerCase() !== 'sha-256') return null;
    seen.add(f[2].toUpperCase());
  }
  return seen.size === 1 ? `sha-256 ${[...seen][0]}` : null;
}

// "sha-256 AB:CD:…" → its first `n` bytes (the pin carried in a passkey's user handle).
export function fingerprintBytes(fingerprint, n = 16) {
  const hex = String(fingerprint ?? '').replace(/^sha-256 /i, '').split(':');
  if (hex.length < n || !hex.slice(0, n).every(h => /^[0-9A-Fa-f]{2}$/.test(h))) return null;
  return Uint8Array.from(hex.slice(0, n), h => parseInt(h, 16));
}

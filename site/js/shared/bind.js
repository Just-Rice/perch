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

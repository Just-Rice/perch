// WebCrypto wrappers shared by the website and the Mac host. All functions take and return Uint8Array.
import { utf8, concat } from './bytes.js';

const subtle = globalThis.crypto.subtle;

export async function sha256(...parts) {
  return new Uint8Array(await subtle.digest('SHA-256', concat(...parts)));
}

export async function hmacSha256(keyBytes, ...parts) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, concat(...parts)));
}

// HKDF-SHA256 straight to an AES-GCM-256 key.
export async function hkdfAesKey(secretBytes, salt, info) {
  const base = await subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(salt), info: utf8(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function aesGcmEncrypt(key, iv, plaintext, aad) {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext));
}

// Resolves to null (never throws) when the key, IV, AAD or ciphertext don't match.
export async function aesGcmDecrypt(key, iv, ciphertext, aad) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext));
  } catch {
    return null;
  }
}

// Passkeys (WebAuthn) for Perch: sign-in assertions over the connection's `bind`, discovering which Mac a passkey
// belongs to, and making a new passkey when pairing. The Mac checks everything; this side only asks the browser.
import { toB64url, fromB64url } from '../shared/bytes.js';

export const webauthnAvailable = () =>
  typeof globalThis.PublicKeyCredential === 'function' && !!globalThis.navigator?.credentials?.get;

const b64 = buf => toB64url(new Uint8Array(buf));

// PublicKeyCredential.toJSON() where the browser has it (Chrome 129+, Safari 18.4+, Firefox 119+); the same JSON shape
// built by hand elsewhere. The Mac expects exactly this shape (docs/PROTOCOL.md, "Control channel: signing in").
export function credentialToJSON(cred) {
  if (typeof cred.toJSON === 'function') {
    try { return cred.toJSON(); } catch { /* some versions throw on extensions; build it by hand */ }
  }
  const r = cred.response;
  const json = {
    id: cred.id,
    rawId: b64(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response: { clientDataJSON: b64(r.clientDataJSON) },
  };
  if (r.attestationObject) {
    json.response.attestationObject = b64(r.attestationObject);
    json.response.transports = r.getTransports ? r.getTransports() : [];
    if (r.getPublicKeyAlgorithm) json.response.publicKeyAlgorithm = r.getPublicKeyAlgorithm();
    if (r.getAuthenticatorData) json.response.authenticatorData = b64(r.getAuthenticatorData());
    if (r.getPublicKey) {
      const pk = r.getPublicKey();
      if (pk) json.response.publicKey = b64(pk);
    }
  } else {
    json.response.authenticatorData = b64(r.authenticatorData);
    json.response.signature = b64(r.signature);
    if (r.userHandle) json.response.userHandle = b64(r.userHandle);
  }
  return json;
}

// PublicKeyCredentialCreationOptionsJSON (what the Mac sends in pair-options) → the options create() takes.
export function parseCreationOptions(json) {
  const PKC = globalThis.PublicKeyCredential;
  if (typeof PKC?.parseCreationOptionsFromJSON === 'function') {
    try { return PKC.parseCreationOptionsFromJSON(json); } catch { /* fall back to doing it by hand */ }
  }
  return {
    ...json,
    challenge: fromB64url(json.challenge),
    user: { ...json.user, id: fromB64url(json.user.id) },
    excludeCredentials: (json.excludeCredentials || []).map(c => ({ ...c, id: fromB64url(c.id) })),
  };
}

// Sign in: the challenge is the connection's bind value, so this signature only works on this one connection.
// Resolves to {json, id, userHandle} (userHandle: Uint8Array or null).
export async function getAssertion({ challenge, rpId, credentialIds = [], timeout = 120000, signal }) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId,
      allowCredentials: credentialIds.map(id => ({ type: 'public-key', id: fromB64url(id) })),
      userVerification: 'required',
      timeout,
    },
    ...(signal ? { signal } : {}),
  });
  if (!cred) throw Object.assign(new Error('no passkey'), { name: 'NotAllowedError' });
  const userHandle = cred.response.userHandle ? new Uint8Array(cred.response.userHandle) : null;
  return { json: credentialToJSON(cred), id: cred.id, userHandle };
}

// Pairing: make a passkey from the Mac's options. Resolves to {json, id}.
export async function createPasskey(optionsJSON, { signal } = {}) {
  const cred = await navigator.credentials.create({ publicKey: parseCreationOptions(optionsJSON), ...(signal ? { signal } : {}) });
  if (!cred) throw Object.assign(new Error('no passkey made'), { name: 'NotAllowedError' });
  return { json: credentialToJSON(cred), id: cred.id };
}

// What a failed WebAuthn call means for the person, in a word the UI can use:
//   'cancelled' (closed, timed out, or the browser wanted a fresh tap), 'exists' (this device already has a passkey for
//   this Mac), 'wrong-site' (passkeys can't be used from this address), 'unsupported', 'failed'.
export function webauthnErrorKind(e) {
  switch (e?.name) {
    case 'NotAllowedError': case 'AbortError': return 'cancelled';
    case 'InvalidStateError': return 'exists';
    case 'SecurityError': return 'wrong-site';
    case 'NotSupportedError': return 'unsupported';
    default: return 'failed';
  }
}

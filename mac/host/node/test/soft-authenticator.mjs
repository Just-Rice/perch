// A software passkey authenticator for tests: makes real WebAuthn registration and sign-in responses (the
// PublicKeyCredential.toJSON() shape a browser sends) with an ES256 key from node:crypto, so the host's checks run
// against genuine signatures without a browser. Every field can be overridden to build bad responses.
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');
const sha256 = b => createHash('sha256').update(b).digest();
export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

// Just enough CBOR (RFC 8949) for attestation objects and COSE keys: ints, byte and text strings, arrays, maps.
export function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.of((major << 5) | n);
    if (n < 256) return Buffer.of((major << 5) | 24, n);
    if (n < 65536) return Buffer.of((major << 5) | 25, n >> 8, n & 255);
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

export class SoftAuthenticator {
  constructor({ rpId, origin, aaguid = Buffer.alloc(16) } = {}) {
    this.rpId = rpId;
    this.origin = origin;
    this.aaguid = aaguid;
    this.credentials = new Map(); // id -> {id, privateKey, publicKey, userHandle, counter, rpId}
  }

  _clientData(type, challenge, o) {
    const cd = { type: o.type ?? type, challenge: o.challenge ?? challenge, origin: o.origin ?? this.origin };
    if (o.crossOrigin !== undefined) cd.crossOrigin = o.crossOrigin; else cd.crossOrigin = false;
    if (o.topOrigin !== undefined) cd.topOrigin = o.topOrigin;
    return Buffer.from(JSON.stringify({ ...cd, ...(o.extraClientData ?? {}) }));
  }

  // options: PublicKeyCredentialCreationOptionsJSON, as the Mac sends in pair-options.
  create(options, o = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const credId = o.credentialIdBytes ?? randomBytes(16);
    const id = b64u(credId);
    const rpId = o.rpId ?? options.rp?.id ?? this.rpId;
    const flags = o.flags ?? (FLAG.UP | FLAG.UV | FLAG.AT);
    const counter = o.counter ?? 0;
    const head = Buffer.alloc(37);
    sha256(rpId).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(counter, 33);
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
    const authData = Buffer.concat([head, this.aaguid, idLen, credId, cose]);
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const clientDataJSON = this._clientData('webauthn.create', options.challenge, o);
    this.credentials.set(id, { id, privateKey, publicKey, userHandle: Buffer.from(options.user.id, 'base64url'), counter, rpId });
    return {
      id: o.id ?? id,
      rawId: o.rawId ?? id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal', 'hybrid'],
        publicKeyAlgorithm: -7,
        publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' })),
        authenticatorData: b64u(authData),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  // A sign-in assertion for `credentialId` (default: the newest credential) over `challenge` (base64url).
  get({ challenge, credentialId }, o = {}) {
    const cred = credentialId ? this.credentials.get(credentialId) : [...this.credentials.values()].at(-1);
    if (!cred) throw new Error('no such credential');
    if (o.counter === undefined) cred.counter += 1;
    const counter = o.counter ?? cred.counter;
    const authData = Buffer.alloc(37);
    sha256(o.rpId ?? cred.rpId).copy(authData, 0);
    authData[32] = o.flags ?? (FLAG.UP | FLAG.UV);
    authData.writeUInt32BE(counter, 33);
    const clientDataJSON = this._clientData('webauthn.get', challenge, o);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), o.signWith ?? cred.privateKey);
    const userHandle = o.userHandle !== undefined ? o.userHandle : b64u(cred.userHandle);
    return {
      id: o.id ?? cred.id,
      rawId: o.rawId ?? cred.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(userHandle !== null ? { userHandle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}

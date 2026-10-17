// Sign-in checks: passkeys, pairing links, authenticator-app codes, the backup password (OPAQUE) and lockouts.
// See docs/PROTOCOL.md, "Control channel: signing in".
//
// Every check here is made over `bind`, the hash that ties a sign-in to one exact WebRTC connection, so a proof
// can't be replayed on another connection. Errors are AuthError with a short `reason` the session sends to the
// viewer (never the details, which go to the log).
import * as opaque from '@serenity-kit/opaque';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import { toB64url, fromB64url, equalBytes, concat, fromUtf8 } from '../../../site/js/shared/bytes.js';
import { bindProof } from '../../../site/js/shared/bind.js';
import { normalizeMacName } from '../../../site/js/shared/rendezvous.js';
import { PAIR_ID_BYTES, PAIR_SECRET_BYTES, PAIR_TTL_MS } from '../../../site/js/shared/proto.js';
import { checkCode, newSecret, otpauthUri, base32 } from './totp.mjs';
import { lockedFor, recordFailure, recordSuccess, MAX_FAILS } from './limits.mjs';

// ES256 (every platform authenticator), EdDSA, RS256 (Windows Hello), in order of preference.
export const COSE_ALGS = [-7, -8, -257];
export const MAX_BAD_PAIR_PROOFS = 3;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const ROUTE_NAMES = { passkey: 'Passkey', backup: 'Backup' };

export class AuthError extends Error {
  constructor(reason, detail = reason, extra = {}) {
    super(detail);
    this.reason = reason;
    Object.assign(this, extra);
  }
}

export function humanDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return mins <= 1 ? '1 minute' : `${mins} minutes`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

const isB64url = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && B64URL_RE.test(s);

// The PublicKeyCredential.toJSON() shape. Checked before anything is decoded so junk can't reach the library.
function checkShape(resp, kind) {
  if (!resp || typeof resp !== 'object') throw new AuthError('bad-passkey', 'credential is not an object');
  if (!isB64url(resp.id, 1366)) throw new AuthError('bad-passkey', 'credential id is not base64url');
  if (resp.rawId !== resp.id) throw new AuthError('bad-passkey', 'id and rawId differ');
  if (resp.type !== 'public-key') throw new AuthError('bad-passkey', 'credential type is not public-key');
  const r = resp.response;
  if (!r || typeof r !== 'object') throw new AuthError('bad-passkey', 'credential has no response');
  if (!isB64url(r.clientDataJSON, 8192)) throw new AuthError('bad-passkey', 'bad clientDataJSON');
  if (kind === 'get') {
    if (!isB64url(r.authenticatorData, 8192) || !isB64url(r.signature, 2048)) throw new AuthError('bad-passkey', 'bad assertion fields');
    if (r.userHandle != null && !isB64url(r.userHandle, 1024)) throw new AuthError('bad-passkey', 'bad userHandle');
  } else {
    if (!isB64url(r.attestationObject, 65536)) throw new AuthError('bad-passkey', 'bad attestationObject');
  }
}

// Perch's own rule on top of the library's, for registration AND sign-in: the ceremony must have happened in a
// top-level page of an allowed origin. @simplewebauthn/server never checks crossOrigin/topOrigin for registration.
export function checkClientData(resp, type, origins) {
  let cd;
  try { cd = JSON.parse(fromUtf8(fromB64url(resp.response.clientDataJSON))); } catch {
    throw new AuthError('bad-passkey', 'clientDataJSON is not JSON');
  }
  if (!cd || typeof cd !== 'object') throw new AuthError('bad-passkey', 'clientDataJSON is not an object');
  if (cd.type !== type) throw new AuthError('bad-passkey', `clientData type ${cd.type}, expected ${type}`);
  if (cd.crossOrigin !== undefined && cd.crossOrigin !== false) throw new AuthError('bad-passkey', 'made inside a cross-origin frame');
  if (cd.topOrigin !== undefined) throw new AuthError('bad-passkey', 'made inside a frame (topOrigin present)');
  if (!origins.includes(cd.origin)) throw new AuthError('bad-passkey', `origin ${cd.origin} is not allowed`);
  return cd;
}

export class Auth {
  constructor({ store, config, log, now = () => Date.now() }) {
    this.store = store;
    this.origins = config.origins;
    this.rpId = config.rpId;
    this.site = config.site;
    this.log = log;
    this.now = now;
    this.pendingTotp = null;  // {secret} while the Setup page shows a new QR code; never written to disk
    this.pairing = null;      // the one active pairing link
  }

  async init() {
    await opaque.ready;
    if (!this.store.opaqueServerSetup) await this.store.setOpaqueServerSetup(opaque.server.createSetup());
  }

  // --- passkeys ---

  creationOptions(bind) {
    const macName = this.store.macName;
    return {
      challenge: toB64url(bind),
      rp: { id: this.rpId, name: 'Perch' },
      user: { id: toB64url(this.store.userHandle), name: `Perch · ${macName}`, displayName: `Perch on ${macName}` },
      pubKeyCredParams: COSE_ALGS.map(alg => ({ type: 'public-key', alg })),
      timeout: 120000,
      excludeCredentials: this.store.devices.map(d => ({ type: 'public-key', id: d.id, ...(d.transports ? { transports: d.transports } : {}) })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
    };
  }

  // Checks a sign-in assertion over `bind`. Returns the device; its new signature counter is saved straight away.
  async verifyAssertion(response, bind) {
    checkShape(response, 'get');
    const device = this.store.findDevice(response.id);
    if (!device) throw new AuthError('unknown-device', 'credential is not one of this Mac\'s devices');
    const cd = checkClientData(response, 'webauthn.get', this.origins);
    // A valid passkey that signed some other connection's challenge: the SDP was changed on the way.
    if (cd.challenge !== toB64url(bind)) throw new AuthError('bad-proof', 'challenge is not this connection\'s binding');
    const uh = response.response.userHandle;
    if (uh != null && !equalBytes(fromB64url(uh), this.store.userHandle)) {
      throw new AuthError('bad-passkey', 'user handle is not this Mac\'s');
    }
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: toB64url(bind),
        expectedOrigin: this.origins,
        expectedRPID: this.rpId,
        expectedType: 'webauthn.get',
        credential: { id: device.id, publicKey: fromB64url(device.publicKey), counter: device.counter ?? 0, transports: device.transports },
        requireUserVerification: true,
      });
    } catch (e) {
      throw new AuthError('bad-passkey', e.message);
    }
    if (!v.verified || !v.authenticationInfo.userVerified) throw new AuthError('bad-passkey', 'signature did not verify');
    this.store.updateDevice(device.id, { counter: v.authenticationInfo.newCounter });
    return device;
  }

  // Checks a new passkey made over `bind`. Returns what to store; nothing is saved until the code is also right.
  async verifyRegistration(response, bind) {
    checkShape(response, 'create');
    const cd = checkClientData(response, 'webauthn.create', this.origins);
    if (cd.challenge !== toB64url(bind)) throw new AuthError('bad-proof', 'challenge is not this connection\'s binding');
    if (this.store.findDevice(response.id)) throw new AuthError('already-paired', 'this passkey is already paired');
    let v;
    try {
      v = await verifyRegistrationResponse({
        response,
        expectedChallenge: toB64url(bind),
        expectedOrigin: this.origins,
        expectedRPID: this.rpId,
        expectedType: 'webauthn.create',
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: COSE_ALGS,
      });
    } catch (e) {
      throw new AuthError('bad-passkey', e.message);
    }
    if (!v.verified) throw new AuthError('bad-passkey', 'registration did not verify');
    const cred = v.registrationInfo.credential;
    // The id the browser reported must be the one inside the signed authenticator data.
    if (cred.id !== response.id) throw new AuthError('bad-passkey', 'credential id does not match authenticator data');
    const transports = Array.isArray(response.response.transports)
      ? response.response.transports.filter(t => typeof t === 'string' && t.length <= 16).slice(0, 8) : undefined;
    return {
      id: cred.id,
      publicKey: toB64url(cred.publicKey),
      counter: cred.counter,
      ...(transports?.length ? { transports } : {}),
      backedUp: !!v.registrationInfo.credentialBackedUp,
    };
  }

  // --- pairing links ---

  createPairing() {
    if (!this.store.config.totp.set) throw new Error('Set up the authenticator app first.');
    const id = randomBytes(PAIR_ID_BYTES);
    const secret = randomBytes(PAIR_SECRET_BYTES);
    const token = concat(this.store.hostId, this.store.sigKey, id, secret);
    this.pairing = {
      id: toB64url(id),
      secret: new Uint8Array(secret),
      expiresAt: this.now() + PAIR_TTL_MS,
      link: `${this.site}#pair=${toB64url(token)}`,
      badProofs: 0,
      holder: null,
    };
    this.store.activity('pairing', 'Made a pairing link (works once, for 10 minutes)');
    return this.pairingInfo();
  }

  pairingInfo() {
    const p = this.pairing;
    if (!p) return null;
    if (this.now() >= p.expiresAt) {
      this.pairing = null;
      return null;
    }
    return { link: p.link, expiresAt: new Date(p.expiresAt).toISOString() };
  }

  cancelPairing() {
    this.pairing = null;
  }

  // A pairing proof is HMAC(pairSecret, "perch pair v1" ‖ bind): it shows the viewer holds the link and is on this
  // connection. A good proof reserves the link for that session; three bad ones burn it.
  async checkPairProof(pairId, proof, bind, holder) {
    const p = this.pairing;
    if (!p || typeof pairId !== 'string' || pairId !== p.id) throw new AuthError('bad-link', 'no such pairing link');
    if (this.now() >= p.expiresAt) {
      this.pairing = null;
      throw new AuthError('link-expired', 'pairing link expired');
    }
    if (p.holder && p.holder !== holder) throw new AuthError('link-used', 'pairing link is in use by another connection');
    let given = null;
    try { given = isB64url(proof, 64) ? fromB64url(proof) : null; } catch {}
    const expected = await bindProof(p.secret, 'pair', bind);
    if (!given || !equalBytes(given, expected)) {
      p.badProofs++;
      if (p.badProofs >= MAX_BAD_PAIR_PROOFS) {
        this.pairing = null;
        this.store.activity('pairing', 'Pairing link cancelled after 3 wrong proofs');
      }
      throw new AuthError('bad-link', 'pairing proof did not match');
    }
    p.holder = holder;
  }

  // The session holding the link ended without finishing: let the link be used again (until it expires).
  releasePairing(holder) {
    if (this.pairing && this.pairing.holder === holder) this.pairing.holder = null;
  }

  consumePairing(holder) {
    if (this.pairing && this.pairing.holder === holder) this.pairing = null;
  }

  // --- authenticator app ---

  totpStart() {
    const secret = newSecret();
    this.pendingTotp = { secret };
    return { uri: otpauthUri(secret, this.store.macName), secret: base32(secret) };
  }

  async totpConfirm(code) {
    if (!this.pendingTotp) throw new Error('Start setting up the authenticator app first.');
    const step = checkCode(this.pendingTotp.secret, String(code ?? '').replace(/\s/g, ''), { now: this.now() });
    if (step === null) throw new Error('That code didn\'t match. Check that your phone\'s clock is right and try the newest code.');
    const replacing = this.store.config.totp.set;
    await this.store.setTotpSecret(this.pendingTotp.secret);
    // The code just typed must not also work for a sign-in.
    this.store.markTotpUsed(step);
    this.pendingTotp = null;
    this.store.activity('settings', replacing ? 'Authenticator app replaced' : 'Authenticator app set up');
    return { ok: true };
  }

  // Each 30-second code works once (store.markTotpUsed), for the previous, current and next step.
  checkTotp(code) {
    const secret = this.store.totpSecret;
    if (!secret) return false;
    const step = checkCode(secret, code, { now: this.now(), lastStep: this.store.config.totp.lastStep ?? -1 });
    if (step === null) return false;
    this.store.markTotpUsed(step);
    return true;
  }

  // --- backup password (OPAQUE: the Mac never learns the password) ---

  get opaqueUser() { return normalizeMacName(this.store.macName); }

  backupRegisterStart(registrationRequest) {
    if (!isB64url(registrationRequest, 1024)) throw new Error('That registration request is not valid.');
    try {
      return opaque.server.createRegistrationResponse({
        serverSetup: this.store.opaqueServerSetup, userIdentifier: this.opaqueUser, registrationRequest,
      });
    } catch {
      throw new Error('That registration request is not valid.');
    }
  }

  backupRegisterFinish(registrationRecord) {
    if (!isB64url(registrationRecord, 4096)) throw new Error('That registration record is not valid.');
    const replacing = !!this.store.config.backup.record;
    this.store.setBackupRecord(registrationRecord);
    this.store.updateSettings({ backupOn: true });
    this.store.activity('settings', replacing ? 'Backup password changed' : 'Backup password set; backup sign-in is on');
    return { ok: true };
  }

  // Returns {serverLoginState, loginResponse}, or null for a malformed request.
  opaqueLoginStart(startLoginRequest) {
    if (!isB64url(startLoginRequest, 1024)) return null;
    try {
      return opaque.server.startLogin({
        serverSetup: this.store.opaqueServerSetup, userIdentifier: this.opaqueUser,
        registrationRecord: this.store.config.backup.record, startLoginRequest,
      });
    } catch {
      return null;
    }
  }

  // Returns the 64-byte session key, or null if the client's proof is wrong.
  opaqueLoginFinish(serverLoginState, finishLoginRequest) {
    if (!isB64url(finishLoginRequest, 1024)) return null;
    try {
      const { sessionKey } = opaque.server.finishLogin({ serverLoginState, finishLoginRequest });
      return fromB64url(sessionKey);
    } catch {
      return null;
    }
  }

  // --- lockouts (limits.mjs), counted per route: pairing shares the passkey route's counter ---

  static limitRoute(route) { return route === 'backup' ? 'backup' : 'passkey'; }

  lockedFor(route) {
    return lockedFor(this.store.limit(Auth.limitRoute(route)), this.now());
  }

  // Records a failed attempt (and, unless `what` is null, an activity entry); returns how long the route is now
  // locked (0 = still open).
  fail(route, what) {
    const r = Auth.limitRoute(route);
    const before = this.store.limit(r);
    const after = recordFailure(before, this.now());
    this.store.setLimit(r, after);
    if (what) this.store.activity('failure', what);
    const ms = lockedFor(after, this.now());
    if (ms > 0 && after.fails >= MAX_FAILS) {
      this.store.activity('lockout', `${ROUTE_NAMES[r]} sign-in locked for ${humanDuration(ms)} after ${after.fails} failed attempts`);
      this.log?.warn(`${r} sign-in locked for ${Math.round(ms / 1000)} s`);
    }
    return ms;
  }

  // Backup sign-in counts an attempt as soon as it starts, because the viewer learns by itself whether the password
  // was right and might never come back to say. Once the password is proven over this connection, `undo()` takes
  // that count back, so a right password followed by a wrong code is one failure, not two.
  attempt(route) {
    const r = Auth.limitRoute(route);
    const before = this.store.limit(r);
    const lockedMs = this.fail(route, null);
    const after = this.store.limit(r);
    const undo = () => {
      const now = this.store.limit(r);
      // Nothing else failed in between: put the counter back exactly. Otherwise just take one failure off.
      if (now.fails === after.fails && now.lockedUntil === after.lockedUntil) this.store.setLimit(r, { ...before });
      else this.store.setLimit(r, { fails: Math.max(0, now.fails - 1), lockedUntil: now.lockedUntil });
    };
    return { lockedMs, undo };
  }

  succeed(route) {
    this.store.setLimit(Auth.limitRoute(route), recordSuccess());
  }

  note(kind, text) {
    this.store.activity(kind, text);
  }
}

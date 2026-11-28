// One-tap passkey sign-in (docs/PROTOCOL.md, "One-tap sign-in"). The browser's WebRTC certificate is made in advance,
// so a single passkey request can both say which Mac this is (its user handle) and sign this browser's certificate;
// the connection then uses exactly that certificate, and the Mac checks the signature against it.
import { quickChallenge, sdpFingerprint, fingerprintBytes } from '../shared/bind.js';
import { randomBytes, toB64url, equalBytes } from '../shared/bytes.js';

let prepared = null;

// Makes the certificate and reads its fingerprint; resolves to {cert, fingerprint} or null where it can't be done.
export function prepareQuick(PC = globalThis.RTCPeerConnection) {
  prepared ??= (async () => {
    if (typeof PC?.generateCertificate !== 'function') return null;
    const cert = await PC.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    let fingerprint = null;
    const fps = typeof cert.getFingerprints === 'function' ? cert.getFingerprints() : [];
    const sha = fps.find(f => String(f.algorithm).toLowerCase() === 'sha-256');
    if (sha) fingerprint = `sha-256 ${String(sha.value).toUpperCase()}`;
    if (!fingerprint) {
      // Older Safari: read it from an offer made with the certificate.
      const pc = new PC({ certificates: [cert] });
      try {
        pc.createDataChannel('x');
        fingerprint = sdpFingerprint((await pc.createOffer()).sdp);
      } finally { pc.close(); }
    }
    return fingerprint ? { cert, fingerprint } : null;
  })().catch(() => null);
  return prepared;
}

// The challenge for one passkey request, and the {r, ts} the Mac needs to check it.
export async function quickRequest(q, now = Date.now()) {
  const r = randomBytes(16);
  return { challenge: await quickChallenge(r, now, q.fingerprint), proof: { r: toB64url(r), ts: now } };
}

// Does this offer come from the Mac the pin belongs to?
export function offerMatchesPin(offerSdp, pin) {
  const fp = fingerprintBytes(sdpFingerprint(offerSdp));
  return !!fp && equalBytes(fp, pin);
}

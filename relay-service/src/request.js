// What a Mac sends to Perch's relay service to get relay logins, shared by the service (worker.js) and the Mac's
// host (host/node/src/relay.mjs). docs/PROTOCOL.md, "Relay service".
//
// POST /v1/ice  {v: 1, mac, ts, sig, owner?}
//   mac    the Mac's relay key: an Ed25519 public key, 32 bytes, base64url. Made once per Mac and kept in its Keychain.
//   ts     the Mac's clock in milliseconds; the service accepts 5 minutes either way.
//   sig    Ed25519 signature by that key over requestText(...), base64url. Nobody else can spend this Mac's allowance.
//   owner  only on the service owner's own Macs: HMAC-SHA256 of ownerText(mac) keyed with the owner key (the
//          service's OWNER_KEY secret, which the owner also types into Setup on each of their Macs), base64url.
//          The key itself is never sent.

export const REQUEST_VERSION = 1;
export const MAX_SKEW_MS = 5 * 60 * 1000;
export const MAX_BODY_BYTES = 2048;

export const requestText = ({ mac, ts, owner }) => `perch relay v1|${mac}|${ts}|${owner ?? ''}`;
export const ownerText = mac => `perch relay owner v1|${mac}`;

// Why a request was turned down, as the service says it. The Mac shows the owner a plain sentence for each.
export const REFUSALS = Object.freeze({
  mac: 'This Mac has used its share of the shared relay for now.',
  others: 'The shared relay has reached its limit for other people’s Macs for now.',
  total: 'The shared relay has reached its overall limit for now.',
  unknown: 'The shared relay can’t check how much it has been used right now.',
  busy: 'The shared relay is busy. Try again in a few minutes.',
  bad: 'The shared relay didn’t accept this Mac’s request.',
  turn: 'The shared relay couldn’t get a relay login from Cloudflare.',
});

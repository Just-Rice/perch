// Which way a session's connection runs, named the same way on the Mac (logs, Setup) and in the viewer (Connection
// details):
//   lan       direct, between two addresses on the same network
//   internet  direct, through a router's public address (the two ends are on different networks, or the router sends
//             traffic back in to itself)
//   turn      through a TURN relay (the owner's Cloudflare TURN key)
//   worker    through the owner's relay Worker (WebSocket, for networks that block WebRTC)
// Only `lan` is what two devices side by side on one Wi-Fi should get.

export const ROUTE_WORDS = Object.freeze({
  lan: 'Direct, on your network',
  internet: 'Direct, over the internet',
  turn: 'Through Cloudflare’s TURN relay',
  worker: 'Through your relay Worker',
});

// Private, link-local and loopback addresses (IPv4 and IPv6): ones that only mean something inside a network.
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

export function isPrivateAddress(address) {
  return typeof address === 'string' && PRIVATE.test(address.replace(/^\[|\]$/g, ''));
}

// From the chosen candidate pair: each side's candidate type ('host' | 'srflx' | 'prflx' | 'relay') and the far side's
// address. Null when there isn't enough to say.
export function routeOf(localType, remoteType, remoteAddress) {
  if (!localType || !remoteType) return null;
  if (localType === 'relay' || remoteType === 'relay') return 'turn';
  // Two host candidates are on the same network by definition; a learned (prflx) or host address that is private is
  // too. A public IPv6 host address can be on the same network as well, but can't be told apart from far away ones.
  if (localType === 'host' && remoteType === 'host') return 'lan';
  if (isPrivateAddress(remoteAddress)) return 'lan';
  return 'internet';
}

// What kind of page this is: the real site, or a copy served from this computer for testing.
// Test switches (?brokers=, ?test=1, ?demo=1) only work on localhost/127.0.0.1, so a link to the real site can never
// point it at someone else's message server or turn on the demo.
import { BROKERS, ICE_SERVERS, RP_ID } from '../shared/proto.js';

export function pageEnv(loc = globalThis.location) {
  const local = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
  const q = new URLSearchParams(loc.search);
  let brokers = BROKERS;
  if (local && q.get('brokers')) {
    // Only loopback WebSocket servers: the page's own CSP would block anything else anyway.
    const list = q.get('brokers').split(',').map(s => s.trim())
      .filter(u => /^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u));
    if (list.length) brokers = list;
  }
  const test = local && q.get('test') === '1';
  return {
    local,
    test,
    demo: local && q.get('demo') === '1',
    brokers,
    // In tests the Mac and the browser are on the same computer; no public STUN server is needed (or wanted).
    iceServers: test ? [] : ICE_SERVERS,
    // Passkeys belong to the real site's domain; a local copy can only use its own hostname.
    rpId: loc.hostname === RP_ID ? RP_ID : loc.hostname,
    params: q,
  };
}

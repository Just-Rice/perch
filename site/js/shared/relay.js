// Relay (TURN) servers for strict networks. The Mac gets short-lived logins for its owner's own Cloudflare relay and
// passes them to the viewer inside the sealed offer; both sides check them with cleanIceServers first, so nothing but
// plain STUN/TURN entries ever reaches RTCPeerConnection. See docs/PROTOCOL.md, "Relay".

const URL_RE = /^(stun|turn|turns):[A-Za-z0-9.:-]{1,253}(\?transport=(udp|tcp))?$/;

// Port 53 is blocked by browsers (Cloudflare's own advice: leave it out, or ICE gathering waits for a timeout).
const usable = url => URL_RE.test(url) && !/:53(\?|$)/.test(url);

export function cleanIceServers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 4)) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === 'string' && usable(u)).slice(0, 8);
    if (!urls.length) continue;
    const entry = { urls };
    if (urls.some(u => !u.startsWith('stun:'))) {
      // TURN needs its login.
      if (typeof s.username !== 'string' || typeof s.credential !== 'string' ||
          !s.username || !s.credential || s.username.length > 512 || s.credential.length > 512) continue;
      entry.username = s.username;
      entry.credential = s.credential;
    }
    out.push(entry);
  }
  return out;
}

export const hasRelay = list => cleanIceServers(list).some(s => s.urls.some(u => !u.startsWith('stun:')));

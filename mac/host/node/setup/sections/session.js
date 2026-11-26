// Who is connected right now, and a button to end it.
import { $, setText, show, busy } from '../lib/dom.js';
import { dayAndTime, duration } from '../lib/time.js';
import { ROUTE_WORDS } from '../lib/route.js';

const ROUTES = {
  passkey: 'with a passkey',
  backup: 'with the backup password',
  pair: 'just after pairing',
};

export function session(ctx) {
  $('disconnectBtn').addEventListener('click', (e) => busy(e.currentTarget, $('sessionError'), () => ctx.post('disconnect')));

  return {
    render(st) {
      if (!st) return;
      const s = st.session;
      show($('sessionNone'), !s);
      show($('sessionActive'), !!s);
      if (!s) return;
      setText($('sessionViewer'), s.viewer || 'A device');
      setText($('sessionRoute'), ROUTES[s.route] ?? '');
      setText($('sessionSince'), s.since ? `${dayAndTime(s.since)} (${duration(s.since)})` : 'a moment ago');
      // Which way the connection runs: two devices on one network should see "Direct, on your network".
      setText($('sessionPath'), ROUTE_WORDS[s.path] ? `Route: ${ROUTE_WORDS[s.path]}` : '');
      show($('sessionPath'), !!ROUTE_WORDS[s.path]);
    },
  };
}

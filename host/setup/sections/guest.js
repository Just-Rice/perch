// "Show your screen to someone": a guest link lets a person watch (never control) until its time is up or the owner
// stops it. The link carries its own random key; it says nothing about how to reach this Mac otherwise.
import { $, setText, show, say, busy } from '../lib/dom.js';
import { toMs, minutesSeconds } from '../lib/time.js';

export function guest(ctx) {
  const error = $('guestError');
  const link = $('guestLink');
  let timer = null;

  $('guestStartBtn').addEventListener('click', async (e) => {
    const site = $('pairSiteLabel').hidden ? undefined : $('pairSite').value;
    await busy(e.currentTarget, error, () => ctx.post('guestStart', { minutes: Number($('guestMinutes').value), ...(site ? { site } : {}) }));
  });
  $('guestStopBtn').addEventListener('click', async (e) => {
    await busy(e.currentTarget, error, () => ctx.post('guestStop'));
    $('guestStartBtn').focus();
  });
  $('guestCopyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link.value);
      setText($('guestCopyStatus'), 'Copied. Send it only to the person you want to show.');
    } catch {
      link.focus();
      link.select();
      setText($('guestCopyStatus'), 'Selected: press ⌘C to copy it.');
    }
  });

  function countdown(expires) {
    const left = expires - Date.now();
    setText($('guestCountdown'), left > 0 ? `The link works for ${minutesSeconds(left)} more.` : 'The link has run out.');
  }

  function render(st) {
    const g = st.guest;
    clearInterval(timer);
    timer = null;
    show($('guestActive'), !!g);
    show($('guestIdle'), !g);
    if (!g) { say(error, ''); return; }
    if (link.value !== g.link) { link.value = g.link; setText($('guestCopyStatus'), ''); }
    const expires = toMs(g.expiresAt);
    countdown(expires);
    timer = setInterval(() => countdown(expires), 1000);
    setText($('guestWatching'), g.watching === 0 ? 'Nobody is watching yet.'
      : g.watching === 1 ? '1 person is watching now.' : `${g.watching} people are watching now.`);
  }

  return { render };
}

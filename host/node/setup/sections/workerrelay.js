// The Worker relay: the owner's own Cloudflare Worker (relay/), for strict networks, with no payment details needed
// (host/node/src/wsrelay.mjs). Perch checks the address really is a Perch relay, and claims it, before saving.
import { $, setText, show, say, busy } from '../lib/dom.js';
import { confirmInline } from '../lib/confirm.js';
import { dateOnly } from '../lib/time.js';

export function workerRelay(ctx) {
  const url = $('workerRelayUrl');
  const error = $('workerRelayError');
  const ok = $('workerRelayOk');

  url.addEventListener('input', () => say(error, ''));

  $('workerRelayForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say(ok, '');
    if (!url.value.trim()) {
      say(error, 'Paste the relay’s address, as Wrangler printed it.');
      url.focus();
      return;
    }
    const done = await busy($('workerRelaySaveBtn'), error, () => ctx.post('workerRelaySet', { url: url.value.trim() }));
    if (!done) return;
    url.value = '';
    say(ok, 'The relay works and is saved. Devices on strict networks will use it when they need to.');
  });

  $('workerRelayRemoveBtn').addEventListener('click', (e) => {
    confirmInline(e.currentTarget, {
      text: 'Remove the relay? Devices on networks that block direct connections may not be able to connect.',
      yes: 'Remove', danger: true,
      onYes: async () => { await ctx.post('workerRelayRemove'); say(ok, ''); },
    });
  });

  function render(st) {
    const r = st.workerRelay ?? { set: false };
    setText($('workerRelayStatus'), !r.set ? 'Not set up'
      : r.working === false ? `Set up (${r.url}), but the last check failed: ${r.error}`
        : `Set up: ${r.url}${r.setAt ? `, since ${dateOnly(r.setAt)}` : ''}`);
    setText($('workerRelaySaveBtn'), r.set ? 'Check and replace' : 'Check and save');
    show($('workerRelayRemoveHost'), !!r.set);
  }

  return { render };
}

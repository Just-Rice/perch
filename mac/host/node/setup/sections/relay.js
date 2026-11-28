// The optional relay for school or office Wi-Fi: the owner's own Cloudflare TURN key (host/node/src/relay.mjs).
// Perch checks the key with Cloudflare before saving it, so a typo is caught here, not on the train.
import { $, setText, show, say, busy } from '../lib/dom.js';
import { confirmInline } from '../lib/confirm.js';
import { dateOnly } from '../lib/time.js';

export function relay(ctx) {
  const keyId = $('relayKeyId');
  const token = $('relayToken');
  const error = $('relayError');
  const ok = $('relayOk');

  for (const f of [keyId, token]) f.addEventListener('input', () => say(error, ''));

  $('relayForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say(ok, '');
    if (!keyId.value.trim() || !token.value.trim()) {
      say(error, 'Paste both the Turn Token ID and the API Token from Cloudflare.');
      (keyId.value.trim() ? token : keyId).focus();
      return;
    }
    const done = await busy($('relaySaveBtn'), error,
      () => ctx.post('relaySet', { keyId: keyId.value.trim(), apiToken: token.value.trim() }));
    if (!done) return;
    keyId.value = '';
    token.value = '';
    say(ok, 'The relay works and is saved. Devices on strict networks will use it when they need to.');
  });

  $('relayRemoveBtn').addEventListener('click', (e) => {
    confirmInline(e.currentTarget, {
      text: 'Remove the relay? Devices on networks that block direct connections won’t be able to connect.',
      yes: 'Remove', danger: true,
      onYes: async () => { await ctx.post('relayRemove'); say(ok, ''); },
    });
  });

  function render(st) {
    const r = st.relay ?? { set: false };
    setText($('relayStatus'), !r.set ? 'Not set up'
      : r.working === false ? `Set up, but the last check failed: ${r.error}`
        : `Set up${r.setAt ? ` on ${dateOnly(r.setAt)}` : ''}`);
    setText($('relaySaveBtn'), r.set ? 'Check and replace' : 'Check and save');
    show($('relayRemoveHost'), !!r.set);
  }

  return { render };
}

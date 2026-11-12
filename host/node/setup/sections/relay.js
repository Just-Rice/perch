// The optional relay for school or office Wi-Fi: the owner's own Cloudflare TURN key (host/node/src/relay.mjs).
// Perch checks the key with Cloudflare before saving it, so a typo is caught here, not on the train.
import { $, setText, show, say, busy } from '../lib/dom.js';
import { confirmInline } from '../lib/confirm.js';
import { dateOnly } from '../lib/time.js';

const gb = b => {
  const g = (b ?? 0) / 1e9;
  return Number.isInteger(g) ? `${g} GB` : g >= 100 ? `${Math.round(g)} GB` : g >= 10 ? `${g.toFixed(1)} GB` : `${g.toFixed(2)} GB`;
};

export function relay(ctx) {
  // --- Perch's shared relay ---
  const shared = $('setSharedRelay');
  let sharedPending = false;
  shared.addEventListener('change', async () => {
    sharedPending = true;
    try { await ctx.post('updateSettings', { patch: { sharedRelay: shared.checked } }); }
    catch { shared.checked = !shared.checked; }
    finally { sharedPending = false; }
  });
  const ownerKey = $('relayOwnerKey');
  ownerKey.addEventListener('input', () => say($('relayOwnerError'), ''));
  $('relayOwnerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say($('relayOwnerOk'), '');
    if (!ownerKey.value.trim()) { say($('relayOwnerError'), 'Paste the owner key first.'); ownerKey.focus(); return; }
    const done = await busy($('relayOwnerSaveBtn'), $('relayOwnerError'), () => ctx.post('relayOwnerSet', { key: ownerKey.value.trim() }));
    if (!done) return;
    ownerKey.value = '';
    say($('relayOwnerOk'), 'The shared relay knows this is one of your Macs.');
  });
  $('relayOwnerRemoveBtn').addEventListener('click', (e) => {
    confirmInline(e.currentTarget, {
      text: 'Remove the owner key? This Mac then has the same 20 GB share as everyone else.',
      yes: 'Remove', danger: true,
      onYes: async () => { await ctx.post('relayOwnerRemove'); say($('relayOwnerOk'), ''); },
    });
  });

  function renderShared(r) {
    const sh = r.shared ?? {};
    show($('sharedRelay'), !!sh.available);
    if (!sh.available) return;
    if (!sharedPending) shared.checked = sh.on !== false;
    const u = sh.usage;
    let text;
    if (r.set) text = 'Not used: this Mac has a relay of its own (below).';
    else if (!sh.on) text = 'Off.';
    else if (sh.error) text = sh.error;
    else if (u?.owner) {
      text = `Your Mac: ${gb(u.macBytes)} in the last ${u.windowDays} days. Everyone: ${gb(u.totalBytes)} of ${gb(u.totalLimitBytes)}`
        + ` (other people's Macs ${gb(u.othersBytes)} of ${gb(u.othersLimitBytes)}).`;
    } else if (u) text = `This Mac has used ${gb(u.macBytes)} of its ${gb(u.macLimitBytes)} in the last ${u.windowDays} days.`;
    else text = 'Ready. Used only when a device can\u2019t connect directly.';
    setText($('sharedRelayStatus'), text);
    show($('relayOwnerRemoveBtn'), !!sh.owner);
    setText($('relayOwnerSaveBtn'), sh.owner ? 'Check and replace' : 'Check and save');
  }

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
    renderShared(r);
    setText($('relayStatus'), !r.set ? 'Not set up'
      : r.working === false ? `Set up, but the last check failed: ${r.error}`
        : `Set up${r.setAt ? ` on ${dateOnly(r.setAt)}` : ''}`);
    setText($('relaySaveBtn'), r.set ? 'Check and replace' : 'Check and save');
    show($('relayRemoveHost'), !!r.set);
  }

  return { render };
}

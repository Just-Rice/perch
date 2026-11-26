// The Worker relay: the owner's own Cloudflare Worker (relay/), for strict networks, with no payment details needed
// (host/src/wsrelay.mjs). Roost checks the address really is a Roost relay, and claims it, before saving.
// Once it is set up, two backups for it can be added: a copy of the relay elsewhere behind a tunnel with a fixed
// address (workerRelayBackupSet), or one on this PC behind a Cloudflare Quick Tunnel whose address changes, which Roost
// asks the local relay for (workerRelayTunnelSet).
import { $, setText, show, say, busy } from '../lib/dom.js';
import { confirmInline } from '../lib/confirm.js';
import { dateOnly } from '../lib/time.js';

export function workerRelay(ctx) {
  const url = $('workerRelayUrl');
  const error = $('workerRelayError');
  const ok = $('workerRelayOk');
  const bError = $('relayBackupsError');
  const bOk = $('relayBackupsOk');

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
    const backups = ctx.state?.workerRelay?.backup || ctx.state?.workerRelay?.tunnel;
    confirmInline(e.currentTarget, {
      text: 'Remove the relay? Devices on networks that block direct connections may not be able to connect.' +
        (backups ? ' Its backups stop being used too.' : ''),
      yes: 'Remove', danger: true,
      onYes: async () => { await ctx.post('workerRelayRemove'); say(ok, ''); say(bOk, ''); },
    });
  });

  // The two backups work the same way: an address, checked and saved, or removed after confirming.
  function backupForm({ form, input, save, removeBtn, set, remove, empty, saved, confirmText }) {
    $(input).addEventListener('input', () => say(bError, ''));
    $(form).addEventListener('submit', async (e) => {
      e.preventDefault();
      say(bOk, '');
      const value = $(input).value.trim();
      if (!value) { say(bError, empty); $(input).focus(); return; }
      const done = await busy($(save), bError, () => ctx.post(set, { url: value }));
      if (!done) return;
      $(input).value = '';
      say(bOk, saved);
    });
    $(removeBtn).addEventListener('click', (e) => {
      confirmInline(e.currentTarget, {
        text: confirmText, yes: 'Remove', danger: true,
        onYes: async () => { await ctx.post(remove); say(bOk, ''); },
      });
    });
  }
  backupForm({
    form: 'backupRelayForm', input: 'backupRelayUrl', save: 'backupRelaySaveBtn', removeBtn: 'backupRelayRemoveBtn',
    set: 'workerRelayBackupSet', remove: 'workerRelayBackupRemove',
    empty: 'Paste the backup relay’s public address, such as its tunnel’s https:// address.',
    saved: 'The backup relay works and is saved. Your PC uses it whenever the Worker relay can’t be reached.',
    confirmText: 'Remove the backup relay? If the Worker relay is down, devices on strict networks won’t get through.',
  });
  backupForm({
    form: 'tunnelForm', input: 'tunnelUrl', save: 'tunnelSaveBtn', removeBtn: 'tunnelRemoveBtn',
    set: 'workerRelayTunnelSet', remove: 'workerRelayTunnelRemove',
    empty: 'Type the relay’s address on this PC, like http://127.0.0.1:8788.',
    saved: 'The Quick Tunnel works and is saved. Your PC uses it whenever the Worker relay can’t be reached.',
    confirmText: 'Stop using the Quick Tunnel relay on this PC?',
  });

  function render(st) {
    const r = st.workerRelay ?? { set: false };
    setText($('workerRelayStatus'), !r.set ? 'Not set up'
      : r.working === false ? `Set up (${r.url}), but the last check failed: ${r.error}`
        : `Set up: ${r.url}${r.setAt ? `, since ${dateOnly(r.setAt)}` : ''}`);
    const chip = $('workerRelayChip');
    setText(chip, !r.set ? 'Not set up' : r.working === false ? 'Not working' : 'Ready');
    chip.dataset.tone = !r.set ? 'neutral' : r.working === false ? 'bad' : 'good';
    setText($('workerRelaySaveBtn'), r.set ? 'Check and replace' : 'Check and save');
    show($('workerRelayRemoveHost'), !!r.set);
    // Backups only make sense for a relay that's set up.
    show($('relayBackups'), !!r.set);
    setText($('backupRelayStatus'), r.backup ? `Set up: ${r.backup}` : 'Not set up');
    show($('backupRelayForm'), !r.backup);
    show($('backupRelayRemoveHost'), !!r.backup);
    $('backupRelayItem').dataset.on = String(!!r.backup);
    setText($('tunnelStatus'), r.tunnel ? `Set up: asks ${r.tunnel} for the address` : 'Not set up');
    show($('tunnelForm'), !r.tunnel);
    show($('tunnelRemoveHost'), !!r.tunnel);
    $('tunnelItem').dataset.on = String(!!r.tunnel);
  }

  return { render };
}

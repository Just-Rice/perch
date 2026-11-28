// Backup sign-in (optional): the Mac's name + a password + the 6-digit code, for devices without a passkey.
// The password is turned into an OPAQUE registration right here in the page (lib/backup.js); Perch never sees it.
import { $, setText, show, say, busy } from '../lib/dom.js';
import { confirmInline } from '../lib/confirm.js';
import { dateOnly } from '../lib/time.js';
import { passwordStrength } from '../lib/password.js';
import { loadOpaque, registerBackupPassword } from '../lib/backup.js';

export function backup(ctx) {
  const pw = $('backupPw');
  const hint = $('backupHint');
  const showBtn = $('backupShowBtn');
  const toggle = $('backupOn');
  const error = $('backupError');
  const ok = $('backupOk');
  let toggling = false;

  const updateHint = () => {
    const s = passwordStrength(pw.value, ctx.state?.macName);
    setText(hint, s.text);
    hint.dataset.level = s.level;
    return s;
  };
  const reveal = (on) => {
    pw.type = on ? 'text' : 'password';
    showBtn.setAttribute('aria-pressed', String(on));
    setText(showBtn, on ? 'Hide' : 'Show');
  };

  pw.addEventListener('input', () => { updateHint(); say(error, ''); });
  // Fetch the OPAQUE module while the person is still typing, so Save doesn't have to wait for it.
  pw.addEventListener('focus', () => { loadOpaque().catch(() => {}); }, { once: true });
  showBtn.addEventListener('click', () => reveal(pw.type === 'password'));

  $('backupSuggestBtn').addEventListener('click', async (e) => {
    const suggestion = await busy(e.currentTarget, error, () => ctx.post('suggestPassword'));
    if (typeof suggestion !== 'string') return;
    pw.value = suggestion;
    reveal(true); // shown, so it can be written down or saved
    updateHint();
    say(ok, '');
    pw.focus();
    pw.select();
    loadOpaque().catch(() => {});
  });

  $('backupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say(ok, '');
    const strength = updateHint();
    if (!strength.ok) { say(error, strength.text); pw.focus(); return; }
    const password = pw.value;
    const done = await busy($('backupSaveBtn'), error, async () => {
      await registerBackupPassword(password, (action, body) => ctx.post(action, body));
      return true;
    });
    if (!done) return;
    pw.value = '';
    reveal(false);
    updateHint();
    const name = ctx.state?.macName ?? 'this Mac\'s name';
    say(ok, `Saved. Backup sign-in is on: sign in with the username “${name}”, this password and the 6-digit code.`);
  });

  toggle.addEventListener('change', async () => {
    const want = toggle.checked;
    say(ok, ''); // "Saved. Backup sign-in is on…" would now be out of date
    toggling = true;
    const r = await busy(null, error, () => ctx.post('updateSettings', { patch: { backupOn: want } }));
    toggling = false;
    if (r === undefined) toggle.checked = !want;
    render(ctx.state);
  });

  $('backupRemoveBtn').addEventListener('click', (e) => {
    confirmInline(e.currentTarget, {
      text: 'Remove the backup password? Only passkeys will be able to sign in.',
      yes: 'Remove backup sign-in', no: 'Keep it', danger: true,
      onYes: async () => { await ctx.post('backupRemove'); say(ok, ''); },
    });
  });

  function render(st) {
    if (!st) return;
    const b = st.backup ?? {};
    setText($('backupUser'), st.macName);
    $('backupUsername').value = st.macName ?? '';
    setText($('backupStatus'), b.set ? `Set${b.setAt ? ` on ${dateOnly(b.setAt)}` : ''}` : 'Not set');
    if (!toggling) toggle.checked = b.on === true;
    toggle.disabled = !b.set;
    setText($('backupOnHint'), !b.set ? 'Set a password below to turn this on.'
      : b.on ? 'On: you can sign in with the name, the password and the code.'
        : 'Off: only passkeys can sign in. The password is kept for when you turn it back on.');
    setText($('backupFormTitle'), b.set ? 'Change the password' : 'Choose a password');
    setText($('backupSaveBtn'), b.set ? 'Save new password' : 'Save password');
    show($('backupRemoveHost'), b.set === true);
    if (!pw.value) updateHint();
  }

  return { render };
}

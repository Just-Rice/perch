// Step 2: the authenticator app. "Set up" asks Perch for a new secret (kept by Perch only until it's confirmed),
// shows it as a QR code and as text, and a 6-digit code from the app confirms it.
import { $, setText, show, say, busy } from '../lib/dom.js';
import { qrSvg } from '../lib/qr.js';
import { dateOnly } from '../lib/time.js';

export const groupSecret = (secret) => String(secret).replace(/\s/g, '').match(/.{1,4}/g)?.join(' ') ?? '';

export function totp(ctx) {
  const error = $('totpError');
  const ok = $('totpOk');
  const codeInput = $('totpCode');
  let pending = null; // {uri, secret, macName} while waiting for the first code

  async function start(button) {
    say(ok, '');
    const r = await busy(button, error, () => ctx.post('totpStart'));
    if (!r) return;
    pending = { ...r, macName: ctx.state?.macName };
    $('totpQr').replaceChildren(qrSvg(r.uri, 'QR code that adds Perch to your authenticator app'));
    setText($('totpSecret'), groupSecret(r.secret));
    codeInput.value = '';
    render(ctx.state);
    codeInput.focus();
  }

  $('totpStartBtn').addEventListener('click', (e) => start(e.currentTarget));
  $('totpReplaceBtn').addEventListener('click', (e) => start(e.currentTarget));
  $('totpCancelBtn').addEventListener('click', () => {
    pending = null;
    say(error, '');
    render(ctx.state);
    (ctx.state?.totp?.set ? $('totpReplaceBtn') : $('totpStartBtn')).focus();
  });
  // Digits only; spaces some apps show ("123 456") are dropped.
  codeInput.addEventListener('input', () => {
    const digits = codeInput.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== codeInput.value) codeInput.value = digits;
  });
  $('totpForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = codeInput.value.replace(/\D/g, '');
    if (code.length !== 6) {
      say(error, 'Type the 6 digits your authenticator app shows for Perch.');
      codeInput.focus();
      return;
    }
    const r = await busy($('totpConfirmBtn'), error, () => ctx.post('totpConfirm', { code }));
    if (!r) { codeInput.select(); return; }
    pending = null;
    codeInput.value = '';
    render(ctx.state);
    say(ok, 'Done: your authenticator app is set up. Next, pair a device.');
  });

  function render(st) {
    if (!st) return;
    // Starting over (or a new name) makes a half-finished setup meaningless.
    if (pending && pending.macName !== st.macName) pending = null;
    const set = st.totp?.set === true;
    show($('totpPending'), !!pending);
    show($('totpIdle'), !pending && !set);
    show($('totpDone'), !pending && set);
    if (!set) say(ok, '');
    if (pending) setText($('totpAccount'), `Perch (${st.macName})`);
    setText($('totpSetAt'), set && st.totp.setAt ? ` on ${dateOnly(st.totp.setAt)}` : '');
    const num = $('numTotp');
    num.dataset.done = String(set);
    setText(num, set ? '✓' : '2');
  }

  return { render };
}

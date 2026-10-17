// Step 3: pairing a device. The pairing link (and its QR code) lets one device make a passkey for this Mac, once,
// within 10 minutes. The page notices on its own when the device finishes, through the live updates.
import { $, setText, show, say, busy } from '../lib/dom.js';
import { qrSvg } from '../lib/qr.js';
import { toMs, minutesSeconds } from '../lib/time.js';

export function pairing(ctx) {
  const error = $('pairError');
  const okMsg = $('pairOk');
  const expiredMsg = $('pairExpired');
  const goneMsg = $('pairGone');
  const linkInput = $('pairLink');
  let shownLink = null;      // the link whose QR code is on screen
  let shownExpires = 0;      // ...and when it runs out
  let expiredLink = null;    // a link we've seen run out (Perch may not have cleared it yet)
  let devicesBefore = null;  // device ids when the current pairing started, to spot the new one
  let cancelling = false;

  $('pairStartBtn').addEventListener('click', async (e) => {
    say(okMsg, '');
    expiredMsg.hidden = true;
    goneMsg.hidden = true;
    const r = await busy(e.currentTarget, error, () => ctx.post('pairStart'));
    if (r) $('pairActive').focus();
  });
  $('pairActive').tabIndex = -1;
  $('pairCancelBtn').addEventListener('click', async (e) => {
    cancelling = true;
    await busy(e.currentTarget, error, () => ctx.post('pairCancel'));
    cancelling = false;
    $('pairStartBtn').focus();
  });
  $('pairCopyBtn').addEventListener('click', async () => {
    const status = $('pairCopyStatus');
    try {
      await navigator.clipboard.writeText(linkInput.value);
      setText(status, 'Copied. Only open it on your own device.');
    } catch {
      linkInput.focus();
      linkInput.select();
      setText(status, 'Selected: press ⌘C to copy it. Only open it on your own device.');
    }
  });

  const activePairing = (st) => {
    const p = st?.pairing;
    if (!p?.link || p.link === expiredLink) return null;
    const expires = toMs(p.expiresAt);
    return { link: p.link, expires, left: expires - Date.now() };
  };

  function tick(st) {
    const p = activePairing(st);
    if (!p) return;
    if (p.left <= 0) {
      expiredLink = p.link;
      render(st);
      expiredMsg.hidden = false;
      return;
    }
    setText($('pairCountdown'), `This code works for ${minutesSeconds(p.left)} more.`);
    $('pairCountdown').parentElement.dataset.low = String(p.left < 60_000);
  }

  function render(st) {
    if (!st) return;
    const ready = st.totp?.set === true;
    show($('pairLocked'), !ready);
    $('pairStartBtn').disabled = !ready;
    $('stepPair').dataset.disabled = String(!ready);
    if (!ready) { expiredMsg.hidden = true; goneMsg.hidden = true; } // after Start over, an old code means nothing

    const p = activePairing(st);
    if (p && p.left > 0) {
      if (p.link !== shownLink) {
        shownLink = p.link;
        devicesBefore = new Set((st.devices ?? []).map(d => d.id));
        $('pairQr').replaceChildren(qrSvg(p.link, 'Pairing QR code: scan it with your own device'));
        linkInput.value = p.link;
        setText($('pairCopyStatus'), '');
        say(okMsg, '');
        expiredMsg.hidden = true;
        goneMsg.hidden = true;
      }
      shownExpires = p.expires;
      show($('pairActive'), true);
      show($('pairIdle'), false);
      tick(st);
    } else {
      if (shownLink && !st.pairing && devicesBefore && !cancelling) {
        const added = (st.devices ?? []).filter(d => !devicesBefore.has(d.id));
        if (added.length) say(okMsg, `Paired: “${added.at(-1).label}” can now connect to this Mac.`);
        // Perch dropped the code by itself, without a new device: it ran out (and Perch noticed before this page's
        // once-a-second check did, as it does in a background tab), it was tried with wrong proofs too often, or
        // another Setup tab cancelled it. Either way the person should know why it vanished.
        else if (shownExpires - Date.now() < 2000) expiredMsg.hidden = false;
        else if (ready) goneMsg.hidden = false;
      }
      if (shownLink) { shownLink = null; linkInput.value = ''; $('pairQr').replaceChildren(); }
      devicesBefore = null;
      show($('pairActive'), false);
      show($('pairIdle'), true);
    }
    const num = $('numPair');
    const done = (st.devices ?? []).length > 0;
    num.dataset.done = String(done);
    setText(num, done ? '✓' : '3');
  }

  return { render, tick };
}

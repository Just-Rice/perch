// Home's setup stepper and its "at a glance" tiles. The stepper stays until every step is done; once the two that
// matter are done (authenticator app, a paired device) it can be hidden, and the hero offers it back.
import { $, setText, show } from '../lib/dom.js';
import { ago } from '../lib/time.js';

const HIDE_KEY = 'roost-cc-steps-hidden';
const QUALITY = { smooth: 'Smooth', balanced: 'Balanced', sharp: 'Sharp', fast: 'Fast' };

function remember(value) { try { localStorage.setItem(HIDE_KEY, value); } catch { /* private window: fine */ } }
function recall() { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } }

// The steps, from a state snapshot. `skipped`: done by switching the 6-digit code off everywhere instead.
// `hidden`: not offered at all (not Windows, or the app hasn't said yet).
export function setupSteps(st) {
  const s = st?.settings ?? {};
  const totpSet = st?.totp?.set === true;
  const codesOff = ['codeWithPasskey', 'codeWithBackup', 'codeWithPairing'].every(k => s[k] === false);
  const app = st?.app;
  return [
    { id: 'totp', done: totpSet || codesOff, skipped: !totpSet && codesOff },
    { id: 'pair', done: (st?.devices ?? []).length > 0, locked: !totpSet && s.codeWithPairing !== false },
    { id: 'relay', optional: true, done: st?.relay?.set === true || st?.workerRelay?.set === true },
    { id: 'admin', optional: true, done: !!(app?.elevatedTask || app?.elevated),
      hidden: app?.os !== 'windows' },
  ];
}

const BUTTON = {
  totp: ['Set up', 'Manage'],
  pair: ['Pair a device', 'Pair another'],
  relay: ['Set up a relay', 'Manage'],
  admin: ['Turn on', 'Manage'],
};

export function home(ctx) {
  let hidden = recall();
  const rows = { totp: 'stepTotp', pair: 'stepPair', relay: 'stepRelay', admin: 'stepAdmin' };
  const marks = { totp: 'numTotp', pair: 'numPair', relay: 'numRelay', admin: 'numAdmin' };

  const visible = (sel) => { const el = document.querySelector(sel); return !!el && !el.closest('[hidden]'); };
  $('stepTotpBtn').addEventListener('click', () => {
    ctx.go('totpCard');
    // Straight into setting it up, unless it's already set up (then "Manage" only shows it).
    if (visible('#totpStartBtn')) $('totpStartBtn').click();
    else $('totpCard').querySelector('button:not([hidden])')?.focus({ preventScroll: true });
  });
  $('stepPairBtn').addEventListener('click', () => {
    ctx.go('pairCard');
    const start = $('pairStartBtn');
    if (visible('#pairStartBtn') && !start.disabled) start.click();
    else if (!visible('#pairStartBtn')) $('pairLink').focus({ preventScroll: true });
  });
  $('stepRelayBtn').addEventListener('click', () => { ctx.go('network'); ctx.go('relayCard'); });
  $('stepAdminBtn').addEventListener('click', () => { ctx.go('adminCard'); $('setElevation').focus({ preventScroll: true }); });
  $('stepsHideBtn').addEventListener('click', () => { hidden = true; remember('1'); render(ctx.state); $('stepsShowBtn').focus(); });
  $('stepsShowBtn').addEventListener('click', () => {
    hidden = false; remember('0'); render(ctx.state);
    $('setupCard').scrollIntoView({ block: 'nearest' });
    $('hSetup').focus({ preventScroll: true });
  });
  $('hSetup').tabIndex = -1;

  function render(st) {
    if (!st) return;
    const steps = setupSteps(st);
    const shown = steps.filter(s => !s.hidden);
    const required = steps.filter(s => !s.optional);
    const requiredDone = required.every(s => s.done);
    const allDone = shown.every(s => s.done);
    // The first step not done yet is the one to do now.
    const next = shown.find(s => !s.done && !s.locked);
    let n = 0;
    for (const step of steps) {
      const row = $(rows[step.id]);
      row.hidden = !!step.hidden;
      if (step.hidden) continue;
      n++;
      row.dataset.state = step.done ? 'done' : step === next ? 'current' : step.locked ? 'locked' : 'todo';
      const mark = $(marks[step.id]);
      setText(mark, step.skipped ? '–' : step.done ? '✓' : String(n));
      mark.dataset.done = String(step.done);
      const button = $(`${rows[step.id]}Btn`);
      setText(button, BUTTON[step.id][step.done ? 1 : 0]);
      button.className = `btn${step === next ? ' primary' : step.done ? ' quiet' : ''}`;
      button.disabled = !!step.locked;
    }
    setText($('stepTotpText'), steps[0].skipped
      ? 'Skipped: no 6-digit code is asked for anywhere. Set it up if you want codes back.'
      : 'A 6-digit code from your phone on top of your passkey, so a lost device is never enough.');
    setText($('stepPairText'), steps[1].locked
      ? 'Do step 1 first: pairing asks for a code from your authenticator app.'
      : 'Your phone, tablet or another computer: scan a code once and it can connect.');
    const doneCount = shown.filter(s => s.done).length;
    setText($('stepsProgress'), allDone ? 'All done' : `${doneCount} of ${shown.length} done` +
      (requiredDone ? ' · the rest is optional' : ''));
    $('stepsBar').style.setProperty('--p', String(Math.round((doneCount / shown.length) * 100)));
    // A Start over (or anything else that undoes a needed step) brings the steps back.
    if (!requiredDone) hidden = false;
    const folded = allDone || (hidden && requiredDone);
    show($('setupCard'), !folded);
    show($('stepsHideBtn'), requiredDone && !allDone);
    show($('stepsShowBtn'), folded);
    setText($('stepsShowBtn'), allDone ? 'Show the setup steps' : `Setup: ${doneCount} of ${shown.length} done · show`);
    $('stepsShowBtn').setAttribute('aria-expanded', String(!folded));
    show($('navHomeDot'), !requiredDone);
    tiles(st, steps);
  }

  function tiles(st, steps) {
    const devs = st.devices ?? [];
    const connected = st.session ? devs.find(d => d.id === st.session.deviceId) : null;
    const lastUsed = devs.map(d => d.lastUsedAt).filter(Boolean).sort().at(-1);
    setText($('tileDevicesValue'), devs.length ? `${devs.length} paired` : 'None yet');
    setText($('tileDevicesSub'), st.session ? `${st.session.viewer || connected?.label || 'A device'} is connected`
      : lastUsed ? `Last used ${ago(lastUsed)}` : devs.length ? 'Not used yet' : 'Pair your phone to start');
    $('tileDevices').dataset.tone = devs.length ? (st.session ? 'live' : 'good') : 'warn';

    const s = st.settings ?? {};
    const totpSet = st.totp?.set === true;
    setText($('tileSecurityValue'), !totpSet && steps[0].skipped ? 'Passkey only'
      : !totpSet ? 'Not set up' : s.codeWithPasskey === false ? 'Passkey only' : 'Passkey + code');
    setText($('tileSecuritySub'), st.backup?.set ? `Backup sign-in ${st.backup.on ? 'on' : 'off'}` : 'No backup password');
    $('tileSecurity').dataset.tone = totpSet || steps[0].skipped ? 'good' : 'warn';

    const turn = st.relay?.set === true, worker = st.workerRelay?.set === true;
    const broken = (turn && st.relay.working === false) || (worker && st.workerRelay.working === false);
    setText($('tileNetworkValue'), broken ? 'Relay needs a look' : turn && worker ? '2 relays ready'
      : turn || worker ? 'Relay ready' : 'Direct only');
    setText($('tileNetworkSub'), `${QUALITY[s.quality] ?? 'Balanced'} quality`);
    $('tileNetwork').dataset.tone = broken ? 'bad' : turn || worker ? 'good' : 'neutral';

    const update = st.update && st.update.version !== st.restart?.version ? st.update : null;
    setText($('tileUpdatesValue'), st.restart ? 'Restart to finish' : update ? `${update.version} available` : 'Up to date');
    setText($('tileUpdatesSub'), st.version ? `Roost ${st.version}${s.autoUpdate ? ' · updates itself' : ''}` : '');
    $('tileUpdates').dataset.tone = st.restart || update ? 'accent' : 'good';
  }

  return { render };
}

// "Control admin apps": Windows (UIPI) keeps an ordinary app's clicks and keys away from apps running as administrator
// (Task Manager, installers, admin consoles), and only an elevated app can show the secure desktop (UAC prompts).
// Switching this on asks the Windows app to register a "highest privileges" logon task and restart elevated through
// it; Windows asks once, with UAC, at the PC. Off goes back to an ordinary start. See docs/WINDOWS-APP.md.
// The snapshot's `app` says how it stands: {os, elevated, elevatedTask, elevationError}. The app answers a request a
// moment later (after Windows' prompt), so until it does the switch shows what was asked for.
import { $, setText, say, busy } from '../lib/dom.js';

const WAIT_MS = 3 * 60_000; // nobody answered Windows' prompt: stop waiting

// -> {tone, chip, status, available}
export function adminState(app, asked = null) {
  if (!app || !app.os) return { tone: 'neutral', chip: 'Unknown', available: false,
    status: 'Waiting for Roost on this PC to say whether this is needed.' };
  if (app.os !== 'windows') return { tone: 'neutral', chip: 'Not needed', available: false,
    status: 'Only Windows keeps apps away from admin apps like this.' };
  if (asked === true && !app.elevatedTask) return { tone: 'warn', chip: 'Waiting for you', available: true,
    status: 'Windows is asking, on this PC, whether Roost may make changes. Choose Yes there.' };
  if (asked === false && app.elevatedTask) return { tone: 'warn', chip: 'Turning off…', available: true,
    status: 'Roost is going back to starting without administrator rights.' };
  if (app.elevatedTask && app.elevated) return { tone: 'good', chip: 'On', available: true,
    status: 'Roost runs with administrator rights: admin apps and Windows\' prompts work from your devices.' };
  if (app.elevatedTask) return { tone: 'warn', chip: 'Almost on', available: true,
    status: 'Set up, but Roost isn\'t running with administrator rights yet. It will after it restarts, or the next ' +
      'time you log on.' };
  if (app.elevated) return { tone: 'good', chip: 'On for now', available: true,
    status: 'Roost was started as administrator this time, but won\'t be after a restart. Switch this on to keep it.' };
  return { tone: 'neutral', chip: 'Off', available: true,
    status: 'Admin apps and Windows\' "Do you want to allow…" prompts can be seen from your devices, but not used.' };
}

export function admin(ctx) {
  const toggle = $('setElevation');
  const error = $('adminError');
  const ok = $('adminOk');
  let saving = false;
  let asked = null;     // what was asked for, until the app's answer arrives
  let askedAt = 0;
  let lastError = null; // the app's last elevationError, shown once

  toggle.addEventListener('change', async () => {
    const want = toggle.checked;
    say(ok, '');
    saving = true;
    lastError = ctx.state?.app?.elevationError ?? null;
    const r = await busy(null, error, async () => { await ctx.post('elevation', { on: want }); return true; });
    saving = false;
    if (r) { asked = want; askedAt = Date.now(); } else toggle.checked = !want;
    render(ctx.state);
  });

  function render(st) {
    if (!st) return;
    const app = st.app;
    // The answer: the task is (or isn't) there now, Windows said no, or nobody answered in time.
    if (asked !== null) {
      const answered = !!app?.elevatedTask === asked;
      const refused = app?.elevationError && app.elevationError !== lastError;
      if (answered) {
        say(ok, asked ? 'On. Roost restarts with administrator rights; this page reconnects by itself.'
          : 'Off. Roost starts without administrator rights from now on.');
        asked = null;
      } else if (refused || Date.now() - askedAt > WAIT_MS) {
        say(error, refused ? `It wasn't switched on: ${app.elevationError}` : 'Windows didn\'t answer. Try again when you\'re at your PC.');
        asked = null;
      }
    }
    if (app?.elevationError !== lastError && asked === null && !saving) lastError = app?.elevationError ?? null;
    const a = adminState(app, asked);
    const chip = $('adminChip');
    setText(chip, a.chip);
    chip.dataset.tone = a.tone;
    setText($('adminStatus'), a.status);
    if (!saving) toggle.checked = asked ?? !!app?.elevatedTask;
    toggle.disabled = saving || !a.available;
  }

  return { render, tick: (st) => { if (asked !== null) render(st); } };
}

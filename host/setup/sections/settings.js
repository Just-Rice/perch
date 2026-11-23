// Settings, in three cards (the 6-digit code switches, video quality, and "This Mac"): each change is saved straight
// away (no Save button). If Perch refuses one, the control goes back to what it was and the reason is shown in that
// control's own card.
import { $, setText, show, say } from '../lib/dom.js';

const IDLE_LABEL = (m) => (m === 0 ? 'Never' : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`);

export function settings(ctx) {
  const idle = $('setIdle');
  const micOutput = $('setMicOutput');
  const pending = new Set(); // settings being saved right now: live updates don't overwrite them meanwhile
  const savedTimers = new Map();

  async function save(control, key, value, revert) {
    const card = control.closest('.card');
    const saved = card.querySelector('.saved');
    const error = card.querySelector('.msg.bad');
    pending.add(key);
    say(error, '');
    setText(saved, 'Saving…');
    try {
      await ctx.post('updateSettings', { patch: { [key]: value } });
      setText(saved, 'Saved.');
      clearTimeout(savedTimers.get(card));
      savedTimers.set(card, setTimeout(() => setText(saved, ''), 2500));
    } catch (e) {
      revert();
      setText(saved, '');
      say(error, e?.message || 'That setting couldn\'t be changed. Please try again.');
    } finally {
      pending.delete(key);
      render(ctx.state);
    }
  }

  const switches = [...document.querySelectorAll('input[data-setting]')];
  // The two sound sliders: shown as percentages, saved when let go (a level of 0–1, or 0–1.5 for what is sent).
  const sliders = [...document.querySelectorAll('input[type=range][data-level]')];
  const showLevel = (input) => setText($(`${input.id}Out`),
    input.id === 'setSpeakers' && Number(input.value) === 0 ? 'Silent' : `${input.value}%`);
  for (const input of sliders) {
    input.addEventListener('input', () => showLevel(input));
    input.addEventListener('change', () => {
      const before = ctx.state?.settings?.[input.dataset.level];
      save(input, input.dataset.level, Number(input.value) / 100, () => {
        if (typeof before === 'number') input.value = String(Math.round(before * 100));
        showLevel(input);
      });
    });
  }
  for (const input of switches) {
    input.addEventListener('change', () => {
      const want = input.checked;
      save(input, input.dataset.setting, want, () => { input.checked = !want; });
    });
  }
  idle.addEventListener('change', () => {
    const before = String(ctx.state?.settings?.idleMinutes ?? '');
    save(idle, 'idleMinutes', Number(idle.value), () => { idle.value = before; });
  });
  micOutput.addEventListener('change', () => {
    const before = ctx.state?.settings?.micOutput ?? '';
    save(micOutput, 'micOutput', micOutput.value, () => { micOutput.value = before; });
  });
  for (const radio of document.querySelectorAll('#setQuality input[type=radio]')) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const before = ctx.state?.settings?.quality;
      save(radio, 'quality', radio.value, () => {
        for (const r of document.querySelectorAll('#setQuality input[type=radio]')) r.checked = r.value === before;
      });
    });
  }

  function render(st) {
    if (!st) return;
    const s = st.settings ?? {};
    for (const input of switches) {
      if (!pending.has(input.dataset.setting)) input.checked = s[input.dataset.setting] === true;
    }
    for (const input of sliders) {
      const v = s[input.dataset.level];
      // Not while it's being dragged or saved: a live update would snap it back.
      if (typeof v === 'number' && !pending.has(input.dataset.level) && document.activeElement !== input) {
        input.value = String(Math.round(v * 100));
      }
      showLevel(input);
    }
    // Keeping the Mac's speakers quiet needs the sound tap (macOS 14.2 and later).
    const tap = st.soundTap === true;
    $('setSpeakers').disabled = !tap;
    setText($('soundHint'), tap
      ? 'These only apply while you\'re connected; afterwards the Mac sounds as usual. At Silent nobody near the Mac ' +
        'hears anything, and you still hear everything on your device. The first time you lower the speakers, macOS asks ' +
        'to let Perch record this Mac\'s sound: allow it at the Mac.'
      : 'This Mac\'s speakers always play as usual while you\'re connected: keeping them quiet needs macOS 14.2 or later.');
    if (!pending.has('idleMinutes') && typeof s.idleMinutes === 'number') {
      const v = String(s.idleMinutes);
      // A value Perch allows but this list doesn't offer still shows correctly.
      if (![...idle.options].some(o => o.value === v)) idle.append(new Option(IDLE_LABEL(s.idleMinutes), v));
      idle.value = v;
    }
    // The Mac's sound outputs, for "talk through this Mac". Only rebuilt when the list really changed, so an open
    // menu isn't yanked away by a live update.
    const outs = Array.isArray(st.audioOutputs) ? st.audioOutputs : [];
    $('micOutputRow').hidden = outs.length === 0;
    const chosen = typeof s.micOutput === 'string' ? s.micOutput : '';
    const want = outs.map(o => [o.uid, o.name]);
    // One that was chosen and has since been unplugged still shows, marked as such.
    if (chosen && !outs.some(o => o.uid === chosen)) want.push([chosen, 'An output that is not connected']);
    const shown = [...micOutput.options].slice(1).map(o => `${o.value}\t${o.textContent}`).join('\n');
    if (want.map(([uid, name]) => `${uid}\t${name}`).join('\n') !== shown) {
      micOutput.replaceChildren(micOutput.options[0], ...want.map(([uid, name]) => new Option(name, uid)));
    }
    if (!pending.has('micOutput')) micOutput.value = chosen;
    if (!pending.has('quality')) {
      for (const r of document.querySelectorAll('#setQuality input[type=radio]')) r.checked = r.value === s.quality;
    }
    // macOS can hold a login item back until it's approved in System Settings.
    const needsApproval = s.loginItem === true && /approval/i.test(st.loginItem?.status ?? '');
    const loginHint = $('loginItemHint');
    setText(loginHint, needsApproval
      ? 'macOS wants your OK: in System Settings, open General › Login Items and switch on Perch.' : '');
    show(loginHint, needsApproval);
  }

  return { render };
}

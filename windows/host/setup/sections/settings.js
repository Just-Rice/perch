// Settings, wherever they are on the page (the hero's quick toggles, the 6-digit code switches, video quality, This PC,
// updates): each change is saved straight away (no Save button). If Roost refuses one, the control goes back to what
// it was and the reason is shown in that control's own card. A setting shown twice (the curtain, say, in the hero and
// under This PC) stays the same in both places.
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
  const showLevel = (input) => {
    setText($(`${input.id}Out`), input.id === 'setSpeakers' && Number(input.value) === 0 ? 'Silent' : `${input.value}%`);
    // How far along the track is filled (the slider's own CSS reads it).
    input.style.setProperty('--fill', `${(Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
  };
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
    // The privacy curtain needs Windows 10 version 2004 or later (a window left out of the capture).
    const noCurtain = st.app?.features?.curtain === false;
    for (const input of switches.filter(i => i.dataset.setting === 'curtain')) input.disabled = noCurtain && !input.checked;
    show($('curtainHint'), noCurtain);
    setText($('quickCurtainHint'), noCurtain ? 'Needs Windows 10 version 2004 or later' : 'Black out the PC\'s screen');
    $('quickCurtain').closest('.qt').dataset.disabled = String(noCurtain);

    for (const input of sliders) {
      const v = s[input.dataset.level];
      // Not while it's being dragged or saved: a live update would snap it back.
      if (typeof v === 'number' && !pending.has(input.dataset.level) && document.activeElement !== input) {
        input.value = String(Math.round(v * 100));
      }
      showLevel(input);
    }
    // Turning the PC's own speakers down needs Windows 10 version 2004 or later.
    const tap = st.soundTap === true;
    $('setSpeakers').disabled = !tap;
    setText($('soundHint'), tap
      ? 'These only apply while you\'re connected; afterwards your PC sounds as usual. At Silent nobody near the PC ' +
        'hears anything, and you still hear everything on your device.'
      : 'Your PC\'s speakers always play as usual while you\'re connected: turning them down needs Windows 10 version ' +
        '2004 or later.');
    if (!pending.has('idleMinutes') && typeof s.idleMinutes === 'number') {
      const v = String(s.idleMinutes);
      // A value Roost allows but this list doesn't offer still shows correctly.
      if (![...idle.options].some(o => o.value === v)) idle.append(new Option(IDLE_LABEL(s.idleMinutes), v));
      idle.value = v;
    }
    // The PC's sound outputs, for "talk through your PC". Only rebuilt when the list really changed, so an open
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
    // Starting with Windows can be switched off behind Roost's back (Task Manager › Startup apps), or fail.
    const status = String(st.loginItem?.status ?? '');
    const blocked = s.loginItem === true && /approval|disabled/i.test(status);
    const failed = s.loginItem === true && /error|fail/i.test(status);
    const loginHint = $('loginItemHint');
    setText(loginHint, blocked
      ? 'Windows has Roost switched off as a startup app: open Task Manager › Startup apps (or Settings › Apps › ' +
        'Startup) and switch Roost on.'
      : failed ? 'Windows didn\'t let Roost add itself to the startup apps. Try switching this off and on again.' : '');
    show(loginHint, blocked || failed);
  }

  return { render };
}

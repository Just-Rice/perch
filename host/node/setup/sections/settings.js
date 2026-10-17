// Settings: each change is saved straight away (no Save button). If Perch refuses one, the control goes back to
// what it was and the reason is shown underneath.
import { $, setText, show, say } from '../lib/dom.js';

const IDLE_LABEL = (m) => (m === 0 ? 'Never' : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`);

export function settings(ctx) {
  const error = $('settingsError');
  const saved = $('settingsSaved');
  const idle = $('setIdle');
  const pending = new Set(); // settings being saved right now: live updates don't overwrite them meanwhile
  let savedTimer = null;

  async function save(key, value, revert) {
    pending.add(key);
    say(error, '');
    setText(saved, 'Saving…');
    try {
      await ctx.post('updateSettings', { patch: { [key]: value } });
      setText(saved, 'Saved.');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => setText(saved, ''), 2500);
    } catch (e) {
      revert();
      setText(saved, '');
      say(error, e?.message || 'That setting couldn\'t be changed. Please try again.');
    } finally {
      pending.delete(key);
      render(ctx.state);
    }
  }

  for (const input of document.querySelectorAll('#settingsCard input[data-setting]')) {
    input.addEventListener('change', () => {
      const want = input.checked;
      save(input.dataset.setting, want, () => { input.checked = !want; });
    });
  }
  idle.addEventListener('change', () => {
    const before = String(ctx.state?.settings?.idleMinutes ?? '');
    save('idleMinutes', Number(idle.value), () => { idle.value = before; });
  });
  for (const radio of document.querySelectorAll('#setQuality input[type=radio]')) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const before = ctx.state?.settings?.quality;
      save('quality', radio.value, () => {
        for (const r of document.querySelectorAll('#setQuality input[type=radio]')) r.checked = r.value === before;
      });
    });
  }

  function render(st) {
    if (!st) return;
    const s = st.settings ?? {};
    for (const input of document.querySelectorAll('#settingsCard input[data-setting]')) {
      if (!pending.has(input.dataset.setting)) input.checked = s[input.dataset.setting] === true;
    }
    if (!pending.has('idleMinutes') && typeof s.idleMinutes === 'number') {
      const v = String(s.idleMinutes);
      // A value Perch allows but this list doesn't offer still shows correctly.
      if (![...idle.options].some(o => o.value === v)) idle.append(new Option(IDLE_LABEL(s.idleMinutes), v));
      idle.value = v;
    }
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

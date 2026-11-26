// "Are you sure?" shown right under the button that asked, instead of a pop-up dialog. Focus goes to the safe choice
// first, Escape backs out, and a failure is shown inside the box so the person can try again.
import { h, say } from './dom.js';

// confirmInline(button, {text, yes, no, danger, onYes, container}) — `onYes` may be async; the box closes when it
// succeeds. The box goes right after the button, or at the end of `container` when given.
export function confirmInline(button, { text, yes, no = 'Cancel', danger = false, onYes, container = null }) {
  (container ?? button.parentElement).querySelector(':scope > .confirm')?.remove();
  const error = h('p', { class: 'msg bad', role: 'alert', hidden: true });
  const yesBtn = h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}` }, yes);
  const noBtn = h('button', { type: 'button', class: 'btn' }, no);
  const box = h('div', { class: 'confirm', role: 'group', 'aria-label': text, 'data-danger': danger ? 'true' : 'false' },
    h('p', {}, text), h('div', { class: 'actions' }, yesBtn, noBtn), error);

  const close = (refocus = true) => {
    box.remove();
    button.hidden = false;
    if (refocus && button.isConnected) button.focus();
  };
  noBtn.addEventListener('click', () => close());
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  yesBtn.addEventListener('click', async () => {
    say(error, '');
    yesBtn.disabled = noBtn.disabled = true;
    yesBtn.setAttribute('aria-busy', 'true');
    try {
      await onYes();
      close(false);
    } catch (e) {
      say(error, e?.message || 'Something went wrong. Please try again.');
      yesBtn.disabled = noBtn.disabled = false;
      yesBtn.removeAttribute('aria-busy');
    }
  });

  button.hidden = true;
  if (container) container.append(box); else button.after(box);
  noBtn.focus();
  return { close, box };
}

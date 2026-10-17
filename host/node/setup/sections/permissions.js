// Step 1: the two macOS permissions. Perch can't switch them on itself; the buttons ask the app to open the right
// page of System Settings (and the first time, macOS shows its own prompt).
import { $, setText, show, busy } from '../lib/dom.js';

const ROWS = { screen: 'permScreen', accessibility: 'permAccessibility' };

export function permissions(ctx) {
  const error = $('permError');
  for (const [which, id] of Object.entries(ROWS)) {
    const row = $(id);
    const button = row.querySelector('[data-open]');
    button.addEventListener('click', () => busy(button, error, async () => {
      await ctx.post('requestPermission', { which });
      row.dataset.asked = 'true';
    }));
  }

  return {
    render(st) {
      const p = st.permissions ?? {};
      for (const [which, id] of Object.entries(ROWS)) {
        const row = $(id);
        const ok = p[which] === true;
        const status = row.querySelector('[data-status]');
        setText(status, ok ? '✓ Allowed' : 'Not allowed yet');
        status.dataset.ok = String(ok);
        show(row.querySelector('[data-hint]'), !ok);
        show(row.querySelector('[data-open]'), !ok);
      }
      const done = p.screen === true && p.accessibility === true;
      const num = $('numPerm');
      num.dataset.done = String(done);
      setText(num, done ? '✓' : '1');
    },
  };
}

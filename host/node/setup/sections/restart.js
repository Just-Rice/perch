// "Restart Perch to finish updating": shown when the Perch.app on disk is a different version from the Perch running
// (an update that replaced the files but couldn't restart Perch). Until it restarts, the old Perch keeps running on
// files that are gone, and macOS may not let it show the screen.
import { $, setText, show, busy } from '../lib/dom.js';

const AUTO_MINUTES = (ms) => Math.max(1, Math.round((Number(ms) || 120000) / 60000));

export function restart(ctx) {
  const status = $('restartStatus');
  const error = $('restartError');

  $('restartBtn').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const ok = await busy(button, error, async () => { await ctx.post('relaunch'); return true; });
    if (!ok) return;
    button.disabled = true; // once is enough
    setText(status, 'Restarting… In a few seconds, open Setup again from the Perch icon in the menu bar.');
  });

  return {
    render(st) {
      const r = st?.restart;
      show($('restartNote'), !!r);
      if (!r) return;
      setText($('restartVersion'), r.version ?? '');
      const minutes = AUTO_MINUTES(r.autoAfterMs);
      setText($('restartDetail'), r.sameSigner === false
        ? `This Mac is still running Perch ${r.running ?? ''}. The new copy is signed differently, so after the restart ` +
          'macOS asks again for Screen Recording and Accessibility: restart while you\'re at this Mac.'
        : `This Mac is still running Perch ${r.running ?? ''}, which may not be able to show its screen. Perch also ` +
          `restarts by itself once nobody has been connected for ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    },
  };
}

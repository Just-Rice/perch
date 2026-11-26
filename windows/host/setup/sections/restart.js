// "Restart Roost to finish updating": shown when the Roost on disk is a different version from the Roost running (an
// update that replaced the files but couldn't restart Roost). Until it restarts, the old Roost keeps running.
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
    setText(status, 'Restarting… In a few seconds, open the Control Center again from the Roost icon in the ' +
      'notification area of the taskbar.');
  });

  return {
    render(st) {
      const r = st?.restart;
      show($('restartNote'), !!r);
      if (!r) return;
      setText($('restartVersion'), r.version ?? '');
      const minutes = AUTO_MINUTES(r.autoAfterMs);
      setText($('restartDetail'), `Your PC is still running Roost ${r.running ?? ''}. Roost also restarts by itself once ` +
        `nobody has been connected for ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    },
  };
}

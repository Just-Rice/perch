// About: version and updates, links, and the big switches: a new name, Start over and Uninstall.
import { $, setText, show, busy } from '../lib/dom.js';
import { confirmInline } from '../lib/confirm.js';

const RELEASES = 'https://github.com/Just-Rice/perch/releases';
const safeReleaseUrl = (url) => (typeof url === 'string' && url.startsWith(`${RELEASES}/`) ? url : RELEASES);

export function about(ctx) {
  const status = $('updateStatus');
  const error = $('aboutError');

  $('checkUpdatesBtn').addEventListener('click', async (e) => {
    setText(status, 'Checking…');
    const r = await busy(e.currentTarget, error, async () => ({ update: await ctx.post('checkForUpdates') }));
    if (!r) { setText(status, ''); return; }
    // Perch answers "no update" when it couldn't reach GitHub too, so don't promise "latest" while it's offline.
    const servers = Array.isArray(ctx.state?.rendezvous) ? ctx.state.rendezvous : [];
    const offline = servers.length > 0 && !servers.some(s => s.connected);
    setText(status, r.update ? '' : offline ? 'Couldn\'t check: this Mac can\'t reach the internet right now.'
      : 'You have the latest version.');
  });

  $('installUpdateBtn').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const r = await busy(button, error, async () => { await ctx.post('installUpdate'); return true; });
    if (!r) return;
    button.disabled = true; // once is enough: Perch is about to restart
    setText(status, 'Updating… Perch will close and open again by itself in a minute or two. Then open Setup ' +
      'again from the menu bar.');
  });

  $('renameMacBtn').addEventListener('click', (e) => {
    const hasBackup = ctx.state?.backup?.set === true;
    confirmInline(e.currentTarget, {
      text: 'Give this Mac a new name? Your devices keep working.' +
        (hasBackup ? ' The backup password is removed, so you\'ll need to set it again.' : ''),
      yes: 'Get a new name', no: 'Keep this name',
      onYes: async () => { await ctx.post('newMacName'); $('macName').focus(); },
    });
  });

  $('resetBtn').addEventListener('click', (e) => {
    confirmInline(e.currentTarget, {
      text: 'Start over? Every device is removed, your authenticator app\'s Perch codes stop working and this Mac ' +
        'gets a new name. This can\'t be undone.',
      yes: 'Start over', no: 'Cancel', danger: true,
      onYes: async () => {
        await ctx.post('reset');
        window.scrollTo({ top: 0 });
        $('macName').focus();
      },
    });
  });

  $('uninstallBtn').addEventListener('click', (e) => {
    confirmInline(e.currentTarget, {
      text: 'Uninstall Perch? It stops now, every device is removed and the app goes to the Trash.',
      yes: 'Uninstall Perch', no: 'Cancel', danger: true,
      onYes: async () => { await ctx.post('uninstall'); ctx.farewell(); },
    });
  });
  $('macName').tabIndex = -1;

  return {
    render(st) {
      if (!st) return;
      setText($('aboutVersion'), st.version ?? '');
      const servers = Array.isArray(st.rendezvous) ? st.rendezvous : [];
      setText($('aboutOnline'), servers.length === 0 ? '—'
        : servers.some(r => r.connected) ? 'Connected' : 'Not connected. Perch keeps trying.');
      const u = st.update;
      show($('updateBox'), !!u);
      if (u) {
        setText($('updateVersion'), u.version);
        setText($('updateNotes'), u.notes ?? '');
        $('updateLink').href = safeReleaseUrl(u.url);
      }
    },
  };
}

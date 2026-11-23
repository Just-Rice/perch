// About: the version and this PC's details (Windows, processor, video encoder), updates, links, and the big switches:
// a new name (made up, or chosen), Start over and Uninstall.
import { $, setText, show, say, busy } from '../lib/dom.js';
import { confirmInline } from '../lib/confirm.js';
import { normalizeMacName, CUSTOM_MAC_NAME_RE } from '../lib/names.js';

// "What's new" only ever links to a release page of Roost (or of Perch, which it grew out of).
const REPOS = ['https://github.com/faarisaahmed/roost/releases', 'https://github.com/Just-Rice/perch/releases'];
const safeReleaseUrl = (url) => (typeof url === 'string' && REPOS.some(r => url.startsWith(`${r}/`)) ? url : REPOS[0]);

// "10.0.22631" -> "Windows 11 (build 22631)"; builds from 22000 on are Windows 11.
export function windowsName(osVersion) {
  const m = /^10\.0\.(\d+)/.exec(String(osVersion ?? ''));
  if (!m) return osVersion ? String(osVersion) : '';
  const build = Number(m[1]);
  return `Windows ${build >= 22000 ? 11 : 10} (build ${build})`;
}
const ARCH = { x64: '64-bit (x64)', arm64: 'Arm (ARM64)', x86: '32-bit (x86)' };

export function about(ctx) {
  const status = $('updateStatus');
  const error = $('aboutError');

  $('checkUpdatesBtn').addEventListener('click', async (e) => {
    setText(status, 'Checking…');
    const r = await busy(e.currentTarget, error, async () => ({ update: await ctx.post('checkForUpdates') }));
    if (!r) { setText(status, ''); return; }
    // Roost answers "no update" when it couldn't reach GitHub too, so don't promise "latest" while it's offline.
    const servers = Array.isArray(ctx.state?.rendezvous) ? ctx.state.rendezvous : [];
    const offline = servers.length > 0 && !servers.some(s => s.connected);
    setText(status, r.update ? '' : offline ? 'Couldn\'t check: your PC can\'t reach the internet right now.'
      : 'You have the latest version.');
  });

  $('installUpdateBtn').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const r = await busy(button, error, async () => { await ctx.post('installUpdate'); return true; });
    if (!r) return;
    button.disabled = true; // once is enough: Roost is about to restart
    setText(status, 'Updating… Roost will close and open again by itself in a minute or two. Then open the Control ' +
      'Center again from the tray icon. If it doesn\'t, a Restart Roost button appears at the top of this page.');
  });

  $('renamePcBtn').addEventListener('click', (e) => {
    const hasBackup = ctx.state?.backup?.set === true;
    confirmInline(e.currentTarget, {
      text: 'Give your PC a new name? Your devices keep working.' +
        (hasBackup ? ' The backup password is removed, so you\'ll need to set it again.' : ''),
      yes: 'Get a new name', no: 'Keep this name',
      onYes: async () => { await ctx.post('newMacName'); },
    });
  });

  // A name the owner picks: allowed, but not recommended (it is easier to guess than a made-up one).
  const customName = $('customName');
  const customError = $('customNameError');
  customName.addEventListener('input', () => say(customError, ''));
  $('customNameForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = normalizeMacName(customName.value);
    if (!CUSTOM_MAC_NAME_RE.test(name)) {
      say(customError, 'Use 4 to 40 letters or numbers, with single hyphens between words, like jordan-desktop.');
      customName.focus();
      return;
    }
    const hasBackup = ctx.state?.backup?.set === true;
    confirmInline($('customNameBtn'), {
      text: `Rename your PC to “${name}”? It's easier to guess than a made-up name. Your devices keep working.` +
        (hasBackup ? ' The backup password is removed, so you\'ll need to set it again.' : ''),
      yes: 'Use this name', no: 'Cancel',
      onYes: async () => {
        try {
          await ctx.post('customMacName', { name });
        } catch (err) {
          say(customError, err.message);
          return;
        }
        customName.value = '';
        $('customNameBox').open = false;
        $('customNameBox').querySelector('summary').focus();
      },
    });
  });

  $('resetBtn').addEventListener('click', (e) => {
    confirmInline(e.currentTarget, {
      text: 'Start over? Every device is removed, your authenticator app\'s Roost codes stop working and your PC ' +
        'gets a new name. This can\'t be undone.',
      yes: 'Start over', no: 'Cancel', danger: true,
      onYes: async () => {
        await ctx.post('reset');
        // Everything starts again from the setup steps on Home.
        ctx.go('home');
        $('pcName').focus();
      },
    });
  });

  $('uninstallBtn').addEventListener('click', (e) => {
    confirmInline(e.currentTarget, {
      text: 'Uninstall Roost? It stops now, every device is removed and Roost is removed from your PC.',
      yes: 'Uninstall Roost', no: 'Cancel', danger: true,
      onYes: async () => { await ctx.post('uninstall'); ctx.farewell(); },
    });
  });

  return {
    render(st) {
      if (!st) return;
      setText($('aboutVersion'), st.version ?? '');
      const app = st.app ?? {};
      setText($('aboutWindows'), windowsName(app.osVersion) || '—');
      setText($('aboutArch'), ARCH[app.arch] ?? (app.arch || '—'));
      setText($('aboutEncoder'), app.features?.encoder || '—');
      const servers = Array.isArray(st.rendezvous) ? st.rendezvous : [];
      setText($('aboutOnline'), servers.length === 0 ? '—'
        : servers.some(r => r.connected) ? 'Connected' : 'Not connected. Roost keeps trying.');
      // Already installed and only waiting for a restart (the note at the top of the page): nothing to install.
      const u = st.update && st.update.version !== st.restart?.version ? st.update : null;
      show($('updateBox'), !!u);
      if (u) {
        setText($('updateVersion'), u.version);
        setText($('updateNotes'), u.notes ?? '');
        $('updateLink').href = safeReleaseUrl(u.url);
      }
    },
  };
}

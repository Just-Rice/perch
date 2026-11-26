// The page's layout: the three setup steps above everything until they're all done (then one line in the top card,
// which can open them again), and the rest in four tabs. Anything that wants a card seen (an in-page link, the
// address's #fragment, another section, the tests) sends a `perch:reveal` event from inside it: the right tab is
// chosen, or the steps are opened, before it scrolls into view.
import { $, setText, show } from '../lib/dom.js';

const TAB_KEY = 'perch-setup-tab';
const STEPS_KEY = 'perch-setup-steps-open';

function remember(key, value) { try { sessionStorage.setItem(key, value); } catch { /* private window: fine */ } }
function recall(key) { try { return sessionStorage.getItem(key); } catch { return null; } }

export function tabs(ctx) {
  const list = $('tabs');
  const all = [...list.querySelectorAll('[role=tab]')];
  const panelOf = (tab) => $(tab.getAttribute('aria-controls'));
  let stepsOpen = recall(STEPS_KEY) === '1';
  let allDone = false;

  function select(tab, { focus = false } = {}) {
    for (const t of all) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      panelOf(t).hidden = !on;
    }
    remember(TAB_KEY, tab.id);
    if (focus) tab.focus();
  }

  for (const [i, tab] of all.entries()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      const to = e.key === 'Home' ? all[0] : e.key === 'End' ? all.at(-1) : step ? all[(i + step + all.length) % all.length] : null;
      if (!to) return;
      e.preventDefault();
      select(to, { focus: true });
    });
  }
  select(all.find(t => t.id === recall(TAB_KEY)) ?? all[0]);

  // --- the setup steps ---
  function layoutSteps(st) {
    // Pairing in progress keeps its code on screen whatever else is true.
    const folded = allDone && !stepsOpen && !st?.pairing;
    show($('steps'), !folded);
    show($('setupDone'), allDone && folded);
    show($('stepsHideRow'), allDone && !folded && !st?.pairing);
    $('stepsShowBtn').setAttribute('aria-expanded', String(!folded));
  }
  function openSteps(open) {
    stepsOpen = open;
    remember(STEPS_KEY, open ? '1' : '0');
    layoutSteps(ctx.state);
  }
  $('stepsShowBtn').addEventListener('click', () => { openSteps(true); $('steps').scrollIntoView({ block: 'start' }); });
  $('pairAnotherBtn').addEventListener('click', () => {
    openSteps(true);
    $('stepPair').scrollIntoView({ block: 'start' });
    $('pairStartBtn').focus({ preventScroll: true });
  });
  $('stepsHideBtn').addEventListener('click', () => { openSteps(false); $('setupDone').scrollIntoView({ block: 'nearest' }); });

  // --- showing a particular card ---
  function reveal(el) {
    const panel = el.closest('[role=tabpanel]');
    if (panel?.hidden) select(all.find(t => panelOf(t) === panel));
    if (el.closest('#steps') && $('steps').hidden) openSteps(true);
  }
  document.addEventListener('perch:reveal', (e) => reveal(e.target));
  function go(id) {
    const target = id && document.getElementById(id);
    if (!target) return false;
    reveal(target);
    target.scrollIntoView({ block: 'start' });
    return true;
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a || !go(decodeURIComponent(a.hash.slice(1)))) return;
    e.preventDefault();
    history.replaceState(null, '', a.hash);
  });
  addEventListener('hashchange', () => go(decodeURIComponent(location.hash.slice(1))));
  let firstRender = true;

  return {
    render(st) {
      const devices = (st.devices ?? []).length;
      const perms = st.permissions?.screen === true && st.permissions?.accessibility === true;
      const codesOff = st.settings && ['codeWithPasskey', 'codeWithBackup', 'codeWithPairing'].every(k => st.settings[k] === false);
      const totp = st.totp?.set === true || codesOff;
      allDone = perms && totp && devices > 0;
      setText($('doneTotp'), st.totp?.set ? 'Authenticator app' : 'No codes asked for');
      setText($('tabDeviceCount'), devices ? `${devices} device${devices === 1 ? '' : 's'}` : '');
      show($('pairAnotherBtn'), devices > 0);
      layoutSteps(st);
      if (firstRender) {
        firstRender = false;
        go(decodeURIComponent(location.hash.slice(1)));
      }
    },
  };
}

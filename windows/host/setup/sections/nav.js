// The Control Center's sections: the sidebar (a bottom tab bar on phones) shows one of them at a time. Anything that
// wants a card seen (an in-page link, the address's #fragment, another section, the tests) sends a `roost:reveal`
// event from inside it, or calls ctx.go(id): the right section is shown before the card scrolls into view.
import { $, setText, show } from '../lib/dom.js';

export const VIEWS = ['home', 'devices', 'security', 'network', 'pc', 'about'];
const VIEW_KEY = 'roost-cc-view';

function remember(key, value) { try { sessionStorage.setItem(key, value); } catch { /* private window: fine */ } }
function recall(key) { try { return sessionStorage.getItem(key); } catch { return null; } }

export function nav(ctx) {
  const links = [...document.querySelectorAll('.nav a[data-view]')];
  let current = null;

  function showView(id, { focus = false, scroll = true } = {}) {
    if (!VIEWS.includes(id)) id = 'home';
    for (const v of VIEWS) $(v).hidden = v !== id;
    for (const a of links) {
      if (a.dataset.view === id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    if (current !== id) {
      current = id;
      remember(VIEW_KEY, id);
      document.body.dataset.view = id;
      if (scroll) window.scrollTo({ top: 0 });
    }
    // For keyboard and screen reader users: the new section's heading, so reading starts there.
    if (focus) $(`${id}Title`).focus({ preventScroll: true });
  }

  function reveal(el) {
    const view = el.closest?.('.view');
    if (view && view.hidden) showView(view.id, { scroll: false });
  }
  document.addEventListener('roost:reveal', (e) => reveal(e.target));

  function go(id, { focus = false } = {}) {
    if (!id) return false;
    if (VIEWS.includes(id)) { showView(id, { focus }); return true; }
    const target = document.getElementById(id);
    if (!target || !target.closest('.view')) return false;
    reveal(target);
    target.scrollIntoView({ block: 'start' });
    return true;
  }
  ctx.go = go;

  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a) return;
    const id = decodeURIComponent(a.hash.slice(1));
    if (!go(id, { focus: !!a.closest('.nav') })) return;
    e.preventDefault();
    history.replaceState(null, '', a.hash);
  });
  addEventListener('hashchange', () => go(decodeURIComponent(location.hash.slice(1))));

  // Up and down (or left and right in the tab bar) move between sections, as in Windows Settings.
  for (const [i, a] of links.entries()) {
    a.addEventListener('keydown', (e) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      const to = e.key === 'Home' ? links[0] : e.key === 'End' ? links.at(-1)
        : step ? links[(i + step + links.length) % links.length] : null;
      if (!to) return;
      e.preventDefault();
      to.focus();
    });
  }

  showView(recall(VIEW_KEY) ?? 'home', { scroll: false });
  let firstRender = true;

  return {
    render(st) {
      const count = (st.devices ?? []).length;
      setText($('navDeviceCount'), count ? String(count) : '');
      show($('navDeviceCount'), count > 0);
      // A dot on About when there's an update to install or a restart to finish it.
      show($('navAboutDot'), !!(st.update || st.restart));
      if (firstRender) {
        firstRender = false;
        go(decodeURIComponent(location.hash.slice(1)));
      }
    },
  };
}

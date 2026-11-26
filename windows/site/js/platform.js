// Perch and Roost on one website: Perch (for a Mac) at /perch/, Roost (for a Windows PC) at /perch/windows/.
//
// This file is in both sites (site/js/ and windows/site/js/, the same file) and is loaded at the top of every page,
// before the page is drawn. It:
//   - remembers which of the two you use, so /perch/ takes someone who uses Roost straight to it;
//   - puts a "Mac · Windows" switch in the page's header, to change at any time;
//   - offers to add the website to a phone's or tablet's home screen, where it opens full screen like an app
//     (Android: an Install button; iPhone and iPad: Share › Add to Home Screen), and registers the small service
//     worker (sw.js) that makes that possible.
// Each page says which site it belongs to: <meta name="perch-platform" content="mac"> or content="windows".
(() => {
  'use strict';

  const CHOICE = 'perch.platform.v1';           // 'mac' or 'windows'
  const DISMISSED = 'perch.install.dismissed.v1'; // the home-screen offer was closed
  const meta = document.querySelector('meta[name="perch-platform"]');
  const here = meta && meta.content === 'windows' ? 'windows' : 'mac';
  const root = here === 'windows' ? '../' : '';  // where Perch's own files (app.html, sw.js) are
  const page = location.pathname.split('/').pop() || '';
  const PAGES = ['', 'index.html', 'connect.html', 'privacy.html'];

  // Storage can be missing or throw (private windows, blocked site data): then nothing is remembered.
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* not remembered */ } },
  };
  let embedded = true;
  try { embedded = window.top !== window; } catch { /* a cross-origin parent */ }

  // The same page on the other site (or its front page).
  function hrefFor(to) {
    const same = PAGES.includes(page) && page !== 'index.html' ? page : '';
    if (to === here) return same || './';
    return (to === 'windows' ? 'windows/' : '../') + same;
  }

  // Someone who uses Roost, opening Perch's front page, goes straight to Roost's. Never with a link's #fragment
  // (a pairing link is for the computer it names), and never inside another page.
  if (here === 'mac' && (page === '' || page === 'index.html') && !location.hash && !embedded
      && store.get(CHOICE) === 'windows') {
    location.replace('windows/' + location.search);
    return;
  }
  // Using a computer's sign-in page is a choice of that kind of computer.
  if (page === 'connect.html') store.set(CHOICE, here);

  // Android (Chrome, Edge, Samsung Internet) offers its own install prompt, which can be shown from a button.
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    showInstall();
  });
  window.addEventListener('appinstalled', () => { deferred = null; document.getElementById('perchInstall')?.remove(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:' && !embedded) {
    navigator.serviceWorker.register(root + 'sw.js', { scope: root || './' }).catch(() => { /* no app, still a website */ });
  }

  function addSwitch() {
    const header = document.querySelector('header.site');
    if (!header || header.querySelector('.platform')) return;
    const group = document.createElement('div');
    group.className = 'platform';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Your computer');
    for (const [to, label] of [['mac', 'Mac'], ['windows', 'Windows']]) {
      const a = document.createElement('a');
      a.href = hrefFor(to);
      a.textContent = label;
      a.dataset.to = to;
      if (to === here) a.setAttribute('aria-current', 'page');
      a.addEventListener('click', () => store.set(CHOICE, to));
      group.append(a);
    }
    const brand = header.querySelector('.brand');
    if (brand) brand.after(group); else header.prepend(group);
  }

  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = () => /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function showInstall() {
    if (embedded || standalone() || store.get(DISMISSED) || document.getElementById('perchInstall')) return;
    if (!matchMedia('(pointer: coarse)').matches) return; // phones and tablets
    const canPrompt = !!deferred;
    if (!canPrompt && !ios()) return;
    const header = document.querySelector('header.site');
    if (!header) return;

    const box = document.createElement('aside');
    box.id = 'perchInstall';
    box.className = 'install';
    box.setAttribute('aria-label', 'Add to your home screen');
    const icon = document.createElement('img');
    icon.src = 'img/app-192.png';
    icon.alt = '';
    icon.width = icon.height = 44;
    const text = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = 'Add Perch to your home screen';
    const how = document.createElement('span');
    how.textContent = canPrompt
      ? 'It opens full screen, like an app, with your Macs and PCs a tap away.'
      : 'Tap Share, then "Add to Home Screen". It opens full screen, like an app.';
    text.append(title, how);
    box.append(icon, text);
    if (canPrompt) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn primary';
      go.textContent = 'Install';
      go.addEventListener('click', async () => {
        const prompt = deferred;
        deferred = null;
        if (!prompt) return;
        prompt.prompt();
        try { await prompt.userChoice; } catch { /* closed */ }
        box.remove();
      });
      box.append(go);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.setAttribute('aria-label', 'Not now');
    close.textContent = '×';
    close.addEventListener('click', () => { store.set(DISMISSED, '1'); box.remove(); });
    box.append(close);
    header.after(box);
  }

  function ready() {
    addSwitch();
    showInstall();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
})();

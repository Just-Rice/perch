// Roost's Control Center: the page Roost opens on this PC to set it up and change how it works. It shows Roost's
// state and keeps it current through a live update stream; every button asks Roost to do one thing (see lib/api.js
// and host/src/setup-server.mjs).
// Each part of the page lives in its own module under sections/, with a render(state) that can run any number of
// times without losing what the person is typing. sections/nav.js shows one section (Home, Devices, …) at a time.
import { $, setText } from './lib/dom.js';
import { getState, post, watch } from './lib/api.js';
import { nav } from './sections/nav.js';
import { hero } from './sections/hero.js';
import { home } from './sections/home.js';
import { admin } from './sections/admin.js';
import { totp } from './sections/totp.js';
import { pairing } from './sections/pairing.js';
import { devices } from './sections/devices.js';
import { backup } from './sections/backup.js';
import { guest } from './sections/guest.js';
import { relay } from './sections/relay.js';
import { workerRelay } from './sections/workerrelay.js';
import { sites } from './sections/sites.js';
import { settings } from './sections/settings.js';
import { session } from './sections/session.js';
import { activity } from './sections/activity.js';
import { about } from './sections/about.js';
import { restart } from './sections/restart.js';
import { startEmbers } from './lib/ember.js';

let state = null;
let stopWatching = () => {};
let gone = false;
const banner = $('banner');

function showBanner(text, tone = 'bad') {
  setText(banner, text);
  banner.dataset.tone = tone;
  banner.hidden = !text;
}

const ctx = {
  get state() { return state; },
  // One request to Roost. Its answer carries the new state, so the page updates at once without waiting for the
  // live stream. Resolves to the action's result; throws an Error with a plain-language message.
  async post(action, body) {
    const r = await post(action, body);
    if (r?.state) apply(r.state);
    return r?.result ?? null;
  },
  // Shows a section, or a card in one (sections/nav.js sets it).
  go: () => false,
  // After Uninstall: Roost is going away, so stop listening and say goodbye.
  farewell() {
    gone = true;
    stopWatching();
    document.body.dataset.gone = 'true';
    for (const el of document.querySelectorAll('main > *')) el.hidden = el.id !== 'farewell';
    showBanner('');
    setText($('statePillText'), 'Uninstalled');
    $('statePill').dataset.tone = 'neutral';
    $('farewell').tabIndex = -1;
    $('farewell').focus();
  },
};

const parts = [nav, hero, home, restart, admin, totp, pairing, devices, backup, guest, relay, workerRelay, sites,
  settings, session, activity, about].map(make => make(ctx));

function apply(next) {
  if (!next || typeof next !== 'object' || gone) return;
  state = next;
  for (const part of parts) {
    try { part.render(next); } catch (e) { console.error('Control Center: render failed', e); }
  }
}

// The background (lib/ember.js): still for anyone who asks their PC for less motion.
startEmbers($('ember'));

// Countdowns every second; "5 minutes ago" and the like every 30 seconds.
setInterval(() => { if (state && !gone) for (const p of parts) p.tick?.(state); }, 1000);
setInterval(() => { if (state && !gone) apply(state); }, 30_000);

function onConnection(status, failures = 0) {
  if (gone) return;
  if (status === 'live') showBanner('');
  else if (status === 'stale') {
    showBanner('This Control Center page is out of date. Open it again from the Roost icon in the notification area ' +
      'of the taskbar.');
  } else if (status === 'lost' && failures >= 2) {
    showBanner('Can\'t reach Roost on this PC. Check that Roost is running (its icon is in the notification area of ' +
      'the taskbar). If it is, open the Control Center again from that icon: this page may be from before Roost last ' +
      'restarted. Trying again…', 'warn');
  }
}

async function start() {
  try {
    apply(await getState());
  } catch (e) {
    if (e.status === 403) { onConnection('stale'); return; }
    showBanner(e.message);
  }
  stopWatching = watch(apply, onConnection);
}

addEventListener('pagehide', () => stopWatching());
addEventListener('pageshow', (e) => { if (e.persisted && !gone) start(); });
start();

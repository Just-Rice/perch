// Perch Setup: the page Perch opens on this Mac to set it up. It shows Perch's state and keeps it current through a
// live update stream; every button asks Perch to do one thing (see lib/api.js and host/node/src/setup-server.mjs).
// Each part of the page lives in its own module under sections/, with a render(state) that can run any number of
// times without losing what the person is typing.
import { $, setText } from './lib/dom.js';
import { getState, post, watch } from './lib/api.js';
import { header } from './sections/header.js';
import { permissions } from './sections/permissions.js';
import { totp } from './sections/totp.js';
import { pairing } from './sections/pairing.js';
import { devices } from './sections/devices.js';
import { backup } from './sections/backup.js';
import { relay } from './sections/relay.js';
import { settings } from './sections/settings.js';
import { session } from './sections/session.js';
import { activity } from './sections/activity.js';
import { about } from './sections/about.js';

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
  // One request to Perch. Its answer carries the new state, so the page updates at once without waiting for the
  // live stream. Resolves to the action's result; throws an Error with a plain-language message.
  async post(action, body) {
    const r = await post(action, body);
    if (r?.state) apply(r.state);
    return r?.result ?? null;
  },
  // After Uninstall: Perch is going away, so stop listening and say goodbye.
  farewell() {
    gone = true;
    stopWatching();
    for (const card of document.querySelectorAll('main > section')) card.hidden = card.id !== 'farewell';
    showBanner('');
    setText($('statePillText'), 'Uninstalled');
    $('statePill').dataset.tone = 'neutral';
    $('farewell').tabIndex = -1;
    $('farewell').focus();
  },
};

const parts = [header, permissions, totp, pairing, devices, backup, relay, settings, session, activity, about].map(make => make(ctx));

function apply(next) {
  if (!next || typeof next !== 'object' || gone) return;
  state = next;
  for (const part of parts) {
    try { part.render(next); } catch (e) { console.error('Setup: render failed', e); }
  }
}

// Countdowns every second; "5 minutes ago" and the like every 30 seconds.
setInterval(() => { if (state && !gone) for (const p of parts) p.tick?.(state); }, 1000);
setInterval(() => { if (state && !gone) apply(state); }, 30_000);

function onConnection(status, failures = 0) {
  if (gone) return;
  if (status === 'live') showBanner('');
  else if (status === 'stale') {
    showBanner('This Setup page is out of date. Open Setup again from the Perch icon in the menu bar.');
  } else if (status === 'lost' && failures >= 2) {
    showBanner('Can\'t reach Perch on this Mac. Check that Perch is running (its icon is in the menu bar). ' +
      'Trying again…', 'warn');
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

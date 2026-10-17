// The connect page: home screen, the three ways in (known Mac, passkey discovery, backup, pairing link), and handing
// a signed-in connection to the viewer. Loaded by js/connect.js only after its frame check passed.
import { pageEnv } from './env.js';
import { MacStore, lastUsedText } from './macs.js';
import { Prefs } from './prefs.js';
import { deviceLabel, isAppleDevice, isTouchFirst } from './device.js';
import { parsePairHash, parseUserHandle } from './pairlink.js';
import { Connection, PerchError } from './connection.js';
import { signIn, loadOpaque } from './signin.js';
import { Screens } from './screens.js';
import { getAssertion, webauthnAvailable, webauthnErrorKind } from './passkey.js';
import { failureMessage, messageFor } from './messages.js';
import { fillIcons, icon } from './icons.js';
import { openInBlankTab } from '../blank.js';
import { Viewer } from '../viewer/viewer.js';
import { toB64url, fromB64url, randomBytes } from '../shared/bytes.js';
import { normalizeMacName, MAC_NAME_RE } from '../shared/rendezvous.js';

const $ = id => document.getElementById(id);

export function start() {
  const env = pageEnv();
  const ua = navigator.userAgent;
  const touchOpts = { maxTouchPoints: navigator.maxTouchPoints || 0, coarsePointer: matchMedia('(pointer: coarse)').matches };
  const app = {
    env,
    apple: isAppleDevice(ua, touchOpts),
    touchFirst: isTouchFirst(ua, touchOpts),
    label: deviceLabel(ua, touchOpts),
    macs: new MacStore(),
    ui: new Screens(document),
    conn: null,
    viewer: null,
    log: env.test || env.demo ? (...a) => console.debug('[perch]', ...a) : () => {},
  };
  app.prefs = new Prefs({ apple: app.apple });
  // Tests and the demo look inside through this; the real site never sets it.
  if (env.test || env.demo) window.__perch = app;

  fillIcons(document);
  wireHome(app);
  app.ui.onCancel = () => cancel(app);
  addEventListener('pagehide', () => { app.conn?.close({ bye: true }); });

  // A pairing link carries secrets in the address: take it out of the address bar (and history) straight away.
  const pair = parsePairHash(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  $('boot').hidden = true;
  if (env.demo) {
    import('./demo.js').then(m => m.startDemo(app));
    return;
  }
  $('app').hidden = false;
  if (pair?.error) return showMessage(app, failureMessage('bad-link'), null);
  if (pair) return runSession(app, { route: 'pair', pair });
  showHome(app);
}

// --- home ---

function wireHome(app) {
  const { env } = app;
  $('btnDiscover').addEventListener('click', () => discover(app));
  $('btnBackup').addEventListener('click', () => showBackup(app));
  $('btnBlank').addEventListener('click', () => {
    // A local test copy keeps its test switches (local brokers) in the new tab; the real site has none to keep.
    const r = openInBlankTab(new URL(`connect.html${env.local ? location.search : ''}`, location.href).href);
    $('blankStatus').textContent = r.ok ? 'Opened Perch in a new about:blank tab.'
      : r.reason === 'blocked' ? 'Your browser blocked the new tab. Allow pop-ups for this page and try again.'
        : `Couldn't open the tab (${r.reason}).`;
  });
  $('backupForm').addEventListener('submit', e => {
    e.preventDefault();
    submitBackup(app);
  });
  for (const b of document.querySelectorAll('[data-home]')) b.addEventListener('click', () => showHome(app));
  $('storageNote').hidden = app.macs.persistent;
  // In an about:blank tab nobody can see the address, so the password form says so.
  let framed = false;
  try { framed = window.top !== window || location.protocol === 'blob:'; } catch { framed = true; }
  $('blankWarning').hidden = !framed;
  if (env.test) $('h-home').dataset.test = '1';
}

function showHome(app, { status } = {}) {
  closeCurrent(app);
  const list = app.macs.list();
  const ul = $('macList');
  ul.replaceChildren();
  for (const mac of list) ul.append(macItem(app, mac));
  $('macsBlock').hidden = list.length === 0;
  // With a Mac in the list, its own button is the main way in; the passkey button steps back a little.
  $('btnDiscover').classList.toggle('primary', list.length === 0);
  $('btnDiscover').textContent = list.length ? 'Sign in with another passkey' : 'Sign in with a passkey';
  fillIcons($('s-home'));
  $('homeLead').hidden = list.length > 0;
  app.ui.showError('homeStatus', status || '');
  app.ui.show('home');
}

function macItem(app, mac) {
  const li = document.createElement('li');
  li.className = 'mac';
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'mac-go';
  const name = mac.label || mac.name || 'Your Mac';
  const text = document.createElement('span');
  text.className = 'mac-text';
  const n = document.createElement('span');
  n.className = 'mac-name';
  n.textContent = name;
  const when = document.createElement('span');
  when.className = 'mac-when';
  when.textContent = lastUsedText(mac.lastUsed);
  text.append(n, when);
  go.append(icon('mac', { size: 26 }), text, icon('chevron'));
  go.setAttribute('aria-label', `Connect to ${name}, ${when.textContent.toLowerCase()}`);
  go.addEventListener('click', () => runSession(app, { route: 'passkey', mac }));

  const forget = document.createElement('button');
  forget.type = 'button';
  forget.className = 'btn quiet small mac-forget';
  forget.textContent = 'Forget';
  forget.setAttribute('aria-label', `Forget ${name}`);
  let armed = null;
  forget.addEventListener('click', () => {
    if (!armed) {
      // Two taps, so a slip of the finger doesn't lose the Mac.
      forget.textContent = 'Tap again to forget';
      armed = setTimeout(() => { armed = null; forget.textContent = 'Forget'; }, 4000);
      return;
    }
    clearTimeout(armed);
    app.macs.forget(mac.hostId);
    showHome(app, {});
    $('homeStatus').hidden = true;
  });
  li.append(go, forget);
  return li;
}

// "Sign in with a passkey" with no Mac in mind: any Perch passkey's user handle says which Mac it is for.
function discover(app) {
  app.ui.showError('homeStatus', '');
  if (!webauthnAvailable()) return showMessage(app, failureMessage('no-webauthn'), null);
  // Called right here in the click: Safari only allows passkey requests straight from a tap.
  getAssertion({ challenge: randomBytes(32), rpId: app.env.rpId }).then(cred => {
    const ids = parseUserHandle(cred.userHandle);
    if (!ids) return showMessage(app, failureMessage('not-perch-passkey'), null);
    const mac = app.macs.save({
      hostId: toB64url(ids.hostId), sigKey: toB64url(ids.sigKey), credentialId: cred.id, lastUsed: Date.now(),
    });
    runSession(app, { route: 'passkey', mac });
  }, e => {
    const kind = webauthnErrorKind(e);
    app.ui.showError('homeStatus', kind === 'cancelled'
      ? 'No passkey was used. If this device has no Perch passkey yet, pair it from Perch\'s Setup on the Mac first.'
      : kind === 'wrong-site' ? "Passkeys can't be used from this address." : `The passkey didn't work (${e.name}).`);
  });
}

// --- backup sign-in ---

function showBackup(app, { error, name } = {}) {
  closeCurrent(app);
  const field = $('macName');
  field.value = name ?? app.prefs.get('backupName') ?? '';
  $('password').value = '';
  app.ui.showError('backupError', error || '');
  app.ui.show('backup', { focus: field.value ? 'password' : 'macName' });
  loadOpaque().catch(() => {}); // fetch the password library while they type
}

function submitBackup(app) {
  const name = normalizeMacName($('macName').value);
  const password = $('password').value;
  if (!MAC_NAME_RE.test(name)) {
    app.ui.showError('backupError', "That doesn't look like a Mac name. It has three parts, like amber-otter-4821.");
    $('macName').focus();
    return;
  }
  if (!password) {
    app.ui.showError('backupError', 'Type the backup password you chose in Setup.');
    $('password').focus();
    return;
  }
  app.prefs.set('backupName', name);
  $('password').value = '';
  runSession(app, { route: 'backup', macName: name, password });
}

// --- connecting and signing in ---

async function runSession(app, target) {
  closeCurrent(app);
  const { env, ui } = app;
  const { route, mac, pair } = target;
  const shownName = mac?.label || mac?.name || target.macName || '';
  ui.setMacName(shownName || 'your Mac');
  ui.progress(route === 'pair' ? 'Pairing with your Mac' : shownName ? `Connecting to ${shownName}` : 'Connecting to your Mac');

  const ids = route === 'pair' ? { hostId: pair.hostId, sigKey: pair.sigKey }
    : route === 'passkey' ? { hostId: fromB64url(mac.hostId), sigKey: fromB64url(mac.sigKey) } : {};
  const conn = new Connection({
    route, ...ids, macName: target.macName, pairId: pair?.pairId, label: app.label,
    brokers: env.brokers, iceServers: env.iceServers, log: app.log, onStage: s => ui.stage(s),
  });
  app.conn = conn;
  let saved = mac || null;
  const ctx = {
    route, rpId: env.rpId, label: app.label, credentialId: mac?.credentialId, password: target.password, pair,
    alwaysTap: env.params.get('tap') === '1',
    onHi: hi => ui.setMacName(hi.name),
    onPaired: m => {
      saved = app.macs.save({
        hostId: toB64url(pair.hostId), sigKey: toB64url(pair.sigKey), credentialId: m.credentialId,
        name: m.name || '', lastUsed: Date.now(),
      });
    },
  };
  try {
    const { hi, ready } = await signIn(conn, ctx, ui);
    if (app.conn !== conn) return;
    const name = ready.name || hi.name || shownName;
    if (saved) saved = app.macs.update(saved.hostId, { name, lastUsed: Date.now() }) || saved;
    // What "Reconnect" does later: a paired or known Mac signs in with its passkey; backup asks for the password again.
    const again = saved ? { route: 'passkey', mac: saved } : { route: 'backup-form', macName: target.macName };
    startViewer(app, conn, hi, ready, again);
  } catch (e) {
    if (app.conn !== conn) return;
    app.conn = null;
    conn.close({ bye: true });
    if (!(e instanceof PerchError)) {
      app.log(e);
      return showFailure(app, new PerchError('unexpected', { message: e.message }), target);
    }
    if (e.kind === 'cancelled') return showHome(app);
    showFailure(app, e, target);
  }
}

function cancel(app) {
  const conn = app.conn;
  app.conn = null;
  conn?.close({ bye: true });
  showHome(app);
}

function closeCurrent(app) {
  if (app.viewer) { app.viewer.destroy(); app.viewer = null; }
  if (app.conn) { const c = app.conn; app.conn = null; c.close({ bye: true }); }
  $('viewer').hidden = true;
  $('app').hidden = false;
}

function showFailure(app, err, target) {
  const m = messageFor(err, target.route);
  if (m.action === 'password' && target.route === 'backup') {
    return showBackup(app, { error: `${m.title}. ${m.body}`, name: target.macName });
  }
  showMessage(app, m, target);
}

function showMessage(app, m, target) {
  closeCurrent(app);
  const home = { label: 'Back to start', onClick: () => showHome(app) };
  let primary = home, secondary = null;
  if (m.action === 'reload') {
    primary = { label: 'Reload the page', onClick: () => location.reload() };
    secondary = home;
  } else if ((m.action === 'retry' || m.action === 'code' || m.action === 'password') && target) {
    primary = { label: 'Try again', onClick: () => retry(app, target) };
    secondary = home;
  }
  app.ui.message(m, { primary, secondary });
}

function retry(app, target) {
  if (target.route === 'backup' || target.route === 'backup-form') return showBackup(app, { name: target.macName });
  if (target.route === 'passkey') {
    // Use the freshest copy (the name may have arrived since).
    const mac = app.macs.get(target.mac.hostId) || target.mac;
    return runSession(app, { ...target, mac });
  }
  runSession(app, target);
}

// --- the viewer ---

function startViewer(app, conn, hi, ready, again) {
  $('app').hidden = true;
  const viewer = new Viewer({
    root: $('viewer'),
    session: conn,
    hi,
    ready,
    prefs: app.prefs,
    env: app.env,
    apple: app.apple,
    touchFirst: app.touchFirst,
    log: app.log,
    onLeave: () => {
      app.viewer = null;
      viewer.destroy();
      cancel(app);
    },
    onReconnect: () => retry(app, again),
    onHome: () => showHome(app),
  });
  app.viewer = viewer;
  conn.onclose = (err) => {
    if (app.conn === conn) app.conn = null;
    if (err.kind === 'bye' && err.reason === 'removed' && again.mac) app.macs.forget(again.mac.hostId);
    const m = messageFor(err, again.route);
    viewer.ended(m, { canReconnect: m.action !== 'home' && !(err.kind === 'bye' && err.reason === 'removed') });
  };
  viewer.mount();
  conn.goLive();
}

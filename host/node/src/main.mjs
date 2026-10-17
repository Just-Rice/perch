// Perch's Mac host process. The Swift app starts it (node main.mjs, or the bundled build) and talks to it over
// stdin/stdout (src/ipc.mjs); everything the host logs goes to stderr and $PERCH_HOME/perch.log.
//
// Start-up: read the environment, open the store, get sign-in ready, listen on the rendezvous brokers (retrying in
// the background, 'offline' until one answers), start the local Setup page, and keep the menu bar's status line
// current. On the very first run it opens Setup in the browser.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rendezvous } from '../../../site/js/shared/rendezvous.js';
import { loadConfig } from './config.mjs';
import { createLog } from './log.mjs';
import { HostIpc } from './ipc.mjs';
import { Store } from './store.mjs';
import { Auth } from './auth.mjs';
import { Controller } from './controller.mjs';
import { applyWeriftPatches } from './rtc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_UPDATE_CHECK_MS = 60 * 1000;

const firstExisting = paths => paths.find(p => existsSync(p)) ?? null;

async function optionalImport(load, name, log) {
  try {
    return await load();
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(name)) log.info(`${name} is not part of this build; carrying on without it`);
    else log.error(`could not load ${name}:`, e);
    return null;
  }
}

async function main() {
  const config = loadConfig();
  const log = createLog({ home: config.home, level: config.logLevel });
  // stdout carries IPC frames only: anything a library prints goes to the log instead.
  console.log = console.info = console.debug = (...a) => log.debug(...a);
  console.warn = console.error = (...a) => log.warn(...a);
  // Libraries' ExperimentalWarnings (web crypto, post-quantum keys) are noise for users; keep them in debug logs.
  process.removeAllListeners('warning');
  process.on('warning', w => log.debug(`node warning: ${w.name}: ${w.message}`));
  process.on('unhandledRejection', e => log.error('unhandled rejection:', e));
  process.on('uncaughtException', e => log.error('uncaught exception:', e));

  log.info(`Perch host ${config.version} starting (node ${process.version}${config.test ? ', TEST MODE' : ''})`);
  const patched = applyWeriftPatches();
  if (!patched.unorderedFlag) log.warn('werift: the data channel ordering fix did not apply (werift changed?)');

  const ipc = new HostIpc({ log: log.child('ipc') });
  const firstRun = !existsSync(join(config.home, 'config.json'));

  let store;
  try {
    store = await Store.open({ home: config.home, secrets: config.secrets });
  } catch (e) {
    log.error('could not open the store:', e);
    ipc.command('status', { state: 'error', text: 'Perch couldn’t read its settings or the Keychain. Quit and open Perch again.', macName: '', setupUrl: null, settings: {} });
    ipc.on('close', () => process.exit(1));
    return;
  }
  // Sign-in time (authenticator codes, lockouts, link expiry). Tests may move it forward; nothing else can.
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const auth = new Auth({ store, config, log: log.child('auth'), now });
  await auth.init();

  const rendezvous = new Rendezvous({ brokers: config.brokers, log: m => log.debug(m) });
  const controller = new Controller({ config, store, auth, rendezvous, app: ipc, log, now });
  rendezvous.onstatus = () => controller._changed();

  // --- the app ---
  ipc.on('hello', h => controller.handleHello(h));
  ipc.on('event', ev => controller.handleEvent(ev));
  ipc.on('video', f => controller.handleVideo(f));
  ipc.on('audio', f => controller.handleAudio(f));
  ipc.on('error', e => { log.error('IPC stream broken:', e.message); quit(1); });
  ipc.on('close', () => { log.info('the app closed our stdin; quitting'); quit(0); });

  let lastStatus = '';
  const pushStatus = () => {
    const status = controller.statusCommand();
    const json = JSON.stringify(status);
    if (json === lastStatus) return;
    lastStatus = json;
    ipc.command('status', status);
  };
  controller.onChange(pushStatus);

  let quitting = false;
  let setup = null;
  async function quit(code = 0, { tellApp = false } = {}) {
    if (quitting) return;
    quitting = true;
    try {
      await controller.shutdown('quit');
      await new Promise(r => setTimeout(r, 300)); // let the goodbyes leave
      await setup?.close?.();
    } catch (e) {
      log.error('error while quitting:', e);
    }
    rendezvous.close();
    // "Quit Perch" in the menu: the app waits for this before it quits too.
    if (tellApp) ipc.command('quit', {});
    process.exitCode = code;
    // Give the last frame a moment to reach the app, then go.
    setTimeout(() => process.exit(code), 50);
  }
  controller.onQuit = () => quit(0, { tellApp: true });
  process.on('SIGTERM', () => quit(0));
  process.on('SIGINT', () => quit(0));

  await controller.start();
  pushStatus();
  rendezvous.start(15000).then(
    () => log.info(`rendezvous: ${rendezvous.connectedCount} of ${config.brokers.length} brokers connected`),
    e => log.warn(`${e.message}; still trying in the background`));

  // --- Setup page (built separately; optional so the host still works without it) ---
  const setupMod = await optionalImport(() => import('./setup-server.mjs'), 'setup-server.mjs', log);
  if (setupMod?.startSetupServer) {
    try {
      setup = await setupMod.startSetupServer({
        controller, port: config.setupPort, key: config.setupKey,
        setupDir: firstExisting([join(HERE, 'setup'), join(HERE, '..', 'setup')]),
        opaquePath: firstExisting([
          join(HERE, 'setup', 'vendor', 'opaque', 'index.js'),
          join(HERE, '..', 'setup', 'vendor', 'opaque', 'index.js'),
          join(HERE, '..', '..', '..', 'site', 'js', 'vendor', 'opaque', 'index.js'),
        ]),
        log: log.child('setup'),
      });
      controller.setSetupUrl(setup.url);
      log.info(`Setup page on port ${setup.port}`);
      if (firstRun) ipc.command('open-url', { url: setup.url });
    } catch (e) {
      log.error('could not start the Setup page:', e);
    }
  }

  // --- updates (optional module) ---
  const updater = await optionalImport(() => import('./updater.mjs'), 'updater.mjs', log);
  if (updater?.checkForUpdate) {
    controller.updater = updater;
    if (!config.test) {
      const check = () => controller.checkForUpdates().catch(e => log.debug(e.message));
      setTimeout(check, FIRST_UPDATE_CHECK_MS).unref();
      setInterval(check, UPDATE_EVERY_MS).unref();
    }
  }

  if (config.test && config.testRpcFd !== null) {
    const { startTestRpc } = await import('./test-rpc.mjs');
    startTestRpc(config.testRpcFd, controller, log.child('test'), {
      advanceClock: ms => { clockOffset += Math.max(0, Number(ms) || 0); return clockOffset; },
      setAuthTimeout: ms => { controller.authTimeoutMs = Math.max(100, Number(ms) || 0); return controller.authTimeoutMs; },
    });
  }
  log.info(`ready as ${store.macName}`);
}

main().catch(e => {
  process.stderr.write(`Perch host failed to start: ${e?.stack ?? e}\n`);
  process.exit(1);
});

// The host's settings that come from its environment rather than from config.json.
//
// In normal use none of these can be changed: the host only accepts sign-ins from the real website, makes passkeys
// for the real RP ID and uses the public brokers. Test overrides are honoured ONLY when ROOST_TEST=1, so a stray
// environment variable can never point a real PC at some other website or broker. See docs/PROTOCOL.md, "Test mode".
//
// roost.exe also tells the host where it lives (docs/WINDOWS-APP.md, "Environment the app gives the host"):
// ROOST_APP_EXE (the host keeps its secrets through it, encrypted with DPAPI) and ROOST_INSTALL_DIR (where updates go,
// and its VERSION file says which version is on disk).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { APP_ORIGIN, RP_ID, CONNECT_URL, BROKERS, ICE_SERVERS } from '../../site/js/shared/proto.js';
import { toB64url } from '../../site/js/shared/bytes.js';
import { defaultHome } from './store.mjs';
import pkg from '../package.json' with { type: 'json' };

export const HOST_VERSION = pkg.version;

function originOf(value, name) {
  let u;
  try { u = new URL(value); } catch { throw new Error(`${name} is not a URL: ${value}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${name} must be http(s): ${value}`);
  return u.origin;
}

function brokerList(value) {
  const list = value.split(',').map(s => s.trim()).filter(Boolean);
  for (const b of list) {
    if (!/^wss?:\/\//.test(b)) throw new Error(`ROOST_BROKERS entries must be ws:// or wss:// URLs: ${b}`);
  }
  if (!list.length) throw new Error('ROOST_BROKERS is empty');
  return list;
}

// A full path the app gave us, or null. Relative paths are never trusted: they would depend on the current folder.
function absolutePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0')) return null;
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value) ? value : null;
}

export function loadConfig(env = process.env, platform = process.platform) {
  const test = env.ROOST_TEST === '1';
  // Reads a test-only variable; always undefined outside test mode.
  const t = name => (test && env[name] !== undefined && env[name] !== '') ? env[name] : undefined;

  const setupPort = t('ROOST_SETUP_PORT') !== undefined ? Number(t('ROOST_SETUP_PORT')) : 0;
  if (!Number.isInteger(setupPort) || setupPort < 0 || setupPort > 65535) throw new Error('ROOST_SETUP_PORT must be a port number');

  const iceNone = t('ROOST_ICE') === 'none';
  // The app tells us its version so viewers see it before the app's HELLO arrives. Only a plain version is taken.
  const appVersion = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}([-+][0-9A-Za-z.-]{1,40})?$/.test(env.ROOST_APP_VERSION ?? '')
    ? env.ROOST_APP_VERSION : null;
  const appExe = absolutePath(env.ROOST_APP_EXE);
  const installDir = absolutePath(env.ROOST_INSTALL_DIR);
  return Object.freeze({
    test,
    version: HOST_VERSION,
    appVersion,
    home: t('ROOST_HOME') ?? defaultHome(),
    // Secrets go through roost.exe (DPAPI) on Windows; plain secrets.json in tests (ROOST_SECRETS=file) and anywhere
    // there is no roost.exe to ask (development on another platform).
    secrets: platform === 'win32' && appExe && t('ROOST_SECRETS') !== 'file' ? 'dpapi' : 'file',
    appExe,
    installDir,
    brokers: t('ROOST_BROKERS') ? brokerList(t('ROOST_BROKERS')) : [...BROKERS],
    // Sign-ins are accepted from these origins only.
    origins: [APP_ORIGIN, ...(t('ROOST_TEST_ORIGIN') ? [originOf(t('ROOST_TEST_ORIGIN'), 'ROOST_TEST_ORIGIN')] : [])],
    rpId: t('ROOST_RP_ID') ?? RP_ID,
    // Pairing links are `${site}#pair=...`.
    site: t('ROOST_SITE') ?? CONNECT_URL,
    setupPort,
    setupKey: t('ROOST_SETUP_KEY') ?? toB64url(randomBytes(24)),
    // ROOST_ICE=none: host candidates only, plus loopback so tests work on a PC with no network.
    iceServers: iceNone ? [] : ICE_SERVERS,
    iceLoopback: iceNone,
    logLevel: ['debug', 'info', 'warn', 'error'].includes(env.ROOST_LOG) ? env.ROOST_LOG : (test ? 'debug' : 'info'),
    // Host tests drive the controller over this extra file descriptor (src/test-rpc.mjs).
    testRpcFd: testRpcFd(t('ROOST_TEST_RPC_FD')),
  });
}

function testRpcFd(value) {
  if (value === undefined) return null;
  const fd = Number(value);
  if (!Number.isInteger(fd) || fd < 3 || fd > 255) throw new Error('ROOST_TEST_RPC_FD must be a file descriptor number from 3 up');
  return fd;
}

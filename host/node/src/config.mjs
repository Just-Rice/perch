// The host's settings that come from its environment rather than from config.json.
//
// In normal use none of these can be changed: the host only accepts sign-ins from the real website, makes passkeys
// for the real RP ID and uses the public brokers. Test overrides are honoured ONLY when PERCH_TEST=1, so a stray
// environment variable can never point a real Mac at some other website or broker. See docs/PROTOCOL.md, "Test mode".
import { randomBytes } from 'node:crypto';
import { APP_ORIGIN, RP_ID, CONNECT_URL, BROKERS, ICE_SERVERS } from '../../../site/js/shared/proto.js';
import { toB64url } from '../../../site/js/shared/bytes.js';
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
    if (!/^wss?:\/\//.test(b)) throw new Error(`PERCH_BROKERS entries must be ws:// or wss:// URLs: ${b}`);
  }
  if (!list.length) throw new Error('PERCH_BROKERS is empty');
  return list;
}

export function loadConfig(env = process.env) {
  const test = env.PERCH_TEST === '1';
  // Reads a test-only variable; always undefined outside test mode.
  const t = name => (test && env[name] !== undefined && env[name] !== '') ? env[name] : undefined;

  const setupPort = t('PERCH_SETUP_PORT') !== undefined ? Number(t('PERCH_SETUP_PORT')) : 0;
  if (!Number.isInteger(setupPort) || setupPort < 0 || setupPort > 65535) throw new Error('PERCH_SETUP_PORT must be a port number');

  const iceNone = t('PERCH_ICE') === 'none';
  // The app tells us its version so viewers see it before the app's HELLO arrives. Only a plain version is taken.
  const appVersion = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}([-+][0-9A-Za-z.-]{1,40})?$/.test(env.PERCH_APP_VERSION ?? '')
    ? env.PERCH_APP_VERSION : null;
  return Object.freeze({
    test,
    version: HOST_VERSION,
    appVersion,
    home: t('PERCH_HOME') ?? defaultHome(),
    secrets: t('PERCH_SECRETS') === 'file' ? 'file' : 'keychain',
    brokers: t('PERCH_BROKERS') ? brokerList(t('PERCH_BROKERS')) : [...BROKERS],
    // Sign-ins are accepted from these origins only.
    origins: [APP_ORIGIN, ...(t('PERCH_TEST_ORIGIN') ? [originOf(t('PERCH_TEST_ORIGIN'), 'PERCH_TEST_ORIGIN')] : [])],
    rpId: t('PERCH_RP_ID') ?? RP_ID,
    // Pairing links are `${site}#pair=...`.
    site: t('PERCH_SITE') ?? CONNECT_URL,
    setupPort,
    setupKey: t('PERCH_SETUP_KEY') ?? toB64url(randomBytes(24)),
    // PERCH_ICE=none: host candidates only, plus loopback so tests work on a Mac with no network.
    iceServers: iceNone ? [] : ICE_SERVERS,
    iceLoopback: iceNone,
    logLevel: ['debug', 'info', 'warn', 'error'].includes(env.PERCH_LOG) ? env.PERCH_LOG : (test ? 'debug' : 'info'),
    // Host tests drive the controller over this extra file descriptor (src/test-rpc.mjs).
    testRpcFd: testRpcFd(t('PERCH_TEST_RPC_FD')),
  });
}

function testRpcFd(value) {
  if (value === undefined) return null;
  const fd = Number(value);
  if (!Number.isInteger(fd) || fd < 3 || fd > 255) throw new Error('PERCH_TEST_RPC_FD must be a file descriptor number from 3 up');
  return fd;
}

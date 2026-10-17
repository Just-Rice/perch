// Plain-language messages for every refusal, denial and ending; device labels; the page environment; stats.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  refuseMessage, deniedMessage, byeMessage, errorMessage, failureMessage, messageFor, retryAfterSeconds, formatWait,
} from '../../site/js/ui/messages.js';
import { deviceLabel, browserName, deviceName, isAppleDevice, isTouchFirst } from '../../site/js/ui/device.js';
import { pageEnv } from '../../site/js/ui/env.js';
import { readStats, summarize, linkQuality, statsLines } from '../../site/js/viewer/stats.js';
import { BROKERS, ICE_SERVERS, RP_ID } from '../../site/js/shared/proto.js';

const ACTIONS = new Set(['retry', 'reload', 'home', 'code', 'password']);
const wellFormed = m => {
  assert.equal(typeof m.title, 'string');
  assert.ok(m.title.length > 3 && m.body.length > 10, JSON.stringify(m));
  assert.ok(ACTIONS.has(m.action), m.action);
  assert.ok(Number.isFinite(m.wait));
  assert.doesNotMatch(m.title + m.body, /undefined|null|\[object/);
};

test('every refuse reason in the protocol has its own message', () => {
  const seen = new Set();
  for (const r of ['version', 'busy', 'paused', 'locked-out', 'backup-off', 'not-set-up', 'rate']) {
    const m = refuseMessage(r);
    wellFormed(m);
    assert.ok(!seen.has(m.title), `${r} has a distinct title`);
    seen.add(m.title);
  }
  assert.equal(refuseMessage('version').action, 'reload');
  assert.match(refuseMessage('version').body, /Reload/);
  assert.equal(refuseMessage('backup-off').action, 'home');
  assert.equal(refuseMessage('not-set-up').action, 'home');
  assert.match(refuseMessage('paused').title, /paused/);
});

test('locked-out counts down from retryAfter (seconds), with a sensible default', () => {
  assert.equal(refuseMessage('locked-out', { retryAfter: 90 }).wait, 90);
  assert.equal(refuseMessage('locked-out').wait, 60);
  assert.equal(deniedMessage('locked-out', { retryAfter: 240 }).wait, 240);
  assert.equal(refuseMessage('rate', { retryAfter: 7 }).wait, 7);
  assert.equal(refuseMessage('busy', { retryAfter: 10 }).wait, 10);
});

test('retryAfterSeconds and formatWait', () => {
  assert.equal(retryAfterSeconds(30), 30);
  assert.equal(retryAfterSeconds(2.2), 3);
  assert.equal(retryAfterSeconds(120000), 120, 'more than an hour must be milliseconds');
  assert.equal(retryAfterSeconds(-1), 0);
  assert.equal(retryAfterSeconds('soon'), 0);
  assert.equal(formatWait(1), '1 second');
  assert.equal(formatWait(45), '45 seconds');
  assert.equal(formatWait(60), '1 minute');
  assert.equal(formatWait(125), '2 minutes 5 seconds');
  assert.equal(formatWait(3600), '1 hour');
  assert.equal(formatWait(5400), '1 hour 30 minutes');
  assert.equal(formatWait(0), 'now');
});

test('denied reasons the Mac sends get plain messages', () => {
  // The reasons host/node/src/session.mjs and auth.mjs actually send, plus the protocol's own words.
  const cases = {
    'wrong-code': /code didn't work/, 'locked-out': /Too many/, 'bad-passkey': /passkey/, 'unknown-device': /passkey/,
    'bad-proof': /confirm the connection/, 'wrong-password': /Wrong Mac name or password/, 'bad-link': /pairing link/,
    'link-expired': /expired/, 'link-used': /already used/, 'already-paired': /already paired/, timeout: /too long/,
    origin: /wrong place/, protocol: /understand/, error: /went wrong/,
  };
  for (const [reason, re] of Object.entries(cases)) {
    const m = deniedMessage(reason);
    wellFormed(m);
    assert.match(m.title, re, reason);
  }
});

test('a wrong code that keeps the session open asks for another code', () => {
  assert.equal(deniedMessage('wrong-code', { final: false }).action, 'code');
  assert.equal(deniedMessage('wrong-code', { final: true }).action, 'retry');
  assert.equal(deniedMessage('wrong-password').action, 'password');
  assert.equal(deniedMessage('link-expired').action, 'home');
  assert.equal(deniedMessage('timeout', { route: 'pair' }).action, 'home', 'a pairing link may be used up');
});

test('unknown reasons still read well and say what the Mac said', () => {
  const r = refuseMessage('weird-thing');
  wellFormed(r);
  assert.match(r.body, /weird-thing/);
  wellFormed(deniedMessage(undefined));
  wellFormed(byeMessage('strange'));
});

test('bye reasons', () => {
  const titles = new Set();
  for (const r of ['signed-in-elsewhere', 'paused', 'quit', 'idle', 'removed', 'disconnected']) {
    const m = byeMessage(r);
    wellFormed(m);
    titles.add(m.title);
  }
  assert.equal(titles.size, 6);
  assert.match(byeMessage('signed-in-elsewhere').title, /somewhere else/);
  assert.equal(byeMessage('removed').action, 'home');
});

test('error codes from the Mac', () => {
  assert.match(errorMessage('no-screen-permission').body, /Screen & System Audio Recording/);
  wellFormed(errorMessage('capture-failed'));
  assert.match(errorMessage('other', 'Disk on fire').body, /Disk on fire/);
});

test('failures found on this side', () => {
  const t = failureMessage('timeout');
  assert.equal(`${t.title}. ${t.body}`, "Your Mac didn't answer. Check it's on, awake and running Perch.");
  assert.match(failureMessage('timeout', { route: 'backup' }).title, /No Mac answered to that name/);
  for (const k of ['brokers', 'webrtc', 'lost', 'old-mac', 'no-webauthn', 'not-perch-passkey', 'bad-link', 'wrong-mac',
    'wrong-password', 'protocol', 'unexpected']) wellFormed(failureMessage(k));
  assert.match(failureMessage('old-mac').body, /Check for Updates/);
});

test('messageFor picks the right family from a PerchError-like object', () => {
  assert.equal(messageFor({ kind: 'refuse', reason: 'paused' }).title, refuseMessage('paused').title);
  assert.equal(messageFor({ kind: 'denied', reason: 'locked-out', retryAfter: 33 }).wait, 33);
  assert.equal(messageFor({ kind: 'bye', reason: 'idle' }).title, byeMessage('idle').title);
  assert.equal(messageFor({ kind: 'timeout', message: 'timeout' }, 'passkey').title, "Your Mac didn't answer");
  assert.match(messageFor({ kind: "unexpected", message: "boom" }).body, /boom/);
});

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  androidChrome: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  androidTabletSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Safari/537.36',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
};

test('device labels from user agents', () => {
  assert.equal(deviceLabel(UA.iphoneSafari), 'Safari on iPhone');
  assert.equal(deviceLabel(UA.iphoneChrome), 'Chrome on iPhone');
  assert.equal(deviceLabel(UA.iphoneFirefox), 'Firefox on iPhone');
  assert.equal(deviceLabel(UA.ipadDesktop, { maxTouchPoints: 5 }), 'Safari on iPad', 'iPads in desktop mode');
  assert.equal(deviceLabel(UA.ipadDesktop, { maxTouchPoints: 0 }), 'Safari on Mac');
  assert.equal(deviceLabel(UA.macChrome), 'Chrome on Mac');
  assert.equal(deviceLabel(UA.winChrome), 'Chrome on Windows');
  assert.equal(deviceLabel(UA.winEdge), 'Edge on Windows');
  assert.equal(deviceLabel(UA.linuxFirefox), 'Firefox on Linux');
  assert.equal(deviceLabel(UA.androidChrome), 'Chrome on Android phone');
  assert.equal(deviceLabel(UA.androidTabletSamsung), 'Samsung Internet on Android tablet');
  assert.equal(deviceLabel(UA.chromebook), 'Chrome on Chromebook');
  assert.equal(deviceLabel(''), 'A browser on a device');
  assert.equal(browserName('curl/8'), 'A browser');
  assert.equal(deviceName('Something'), 'a device');
});

test('Apple keyboards and touch-first devices', () => {
  assert.equal(isAppleDevice(UA.iphoneSafari), true);
  assert.equal(isAppleDevice(UA.macChrome), true);
  assert.equal(isAppleDevice(UA.winChrome), false);
  assert.equal(isAppleDevice(UA.androidChrome), false);
  assert.equal(isTouchFirst(UA.iphoneSafari), true);
  assert.equal(isTouchFirst(UA.ipadDesktop, { maxTouchPoints: 5 }), true);
  assert.equal(isTouchFirst(UA.androidChrome), true);
  assert.equal(isTouchFirst(UA.winChrome), false);
  assert.equal(isTouchFirst(UA.winChrome, { coarsePointer: true }), true, 'a Windows touch screen in tablet mode');
});

const loc = url => { const u = new URL(url); return { hostname: u.hostname, search: u.search }; };

test('pageEnv: the real site ignores every test switch', () => {
  const e = pageEnv(loc('https://just-rice.github.io/perch/connect.html?brokers=ws://127.0.0.1:1/mqtt&test=1&demo=1'));
  assert.equal(e.local, false);
  assert.equal(e.test, false);
  assert.equal(e.demo, false);
  assert.equal(e.brokers, BROKERS);
  assert.equal(e.iceServers, ICE_SERVERS);
  assert.equal(e.rpId, RP_ID);
});

test('pageEnv: on this computer, ?brokers= takes loopback servers only', () => {
  const e = pageEnv(loc('http://localhost:8765/connect.html?brokers=ws://127.0.0.1:4000/mqtt,wss://evil.example/mqtt,ws://localhost:5000/mqtt&test=1'));
  assert.deepEqual(e.brokers, ['ws://127.0.0.1:4000/mqtt', 'ws://localhost:5000/mqtt']);
  assert.equal(e.test, true);
  assert.deepEqual(e.iceServers, [], 'tests need no public STUN');
  assert.equal(e.rpId, 'localhost');
  const only = pageEnv(loc('http://127.0.0.1:8765/connect.html?brokers=wss://evil.example/mqtt'));
  assert.equal(only.brokers, BROKERS, 'nothing usable: the normal list');
  assert.equal(pageEnv(loc('http://127.0.0.1:1/connect.html?demo=1')).demo, true);
});

test('pageEnv: some other host gets its own hostname as passkey domain and no test switches', () => {
  const e = pageEnv(loc('https://example.org/connect.html?test=1&brokers=ws://127.0.0.1:1/mqtt'));
  assert.equal(e.rpId, 'example.org');
  assert.equal(e.test, false);
  assert.equal(e.brokers, BROKERS);
});

test('stats: readStats, summarize, linkQuality and the panel lines', () => {
  const report = t => new Map([
    ['v', { type: 'inbound-rtp', kind: 'video', timestamp: t, bytesReceived: t * 500, packetsReceived: t / 10,
      packetsLost: t / 1000, framesDecoded: t / 33, framesPerSecond: 30, frameWidth: 1440, frameHeight: 900,
      decoderImplementation: 'VideoToolbox' }],
    ['a', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 100, packetsReceived: 5, packetsLost: 0 }],
    ['p', { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.012 }],
  ]);
  const a = readStats(report(1000)), b = readStats(report(2000));
  assert.equal(a.video.width, 1440);
  assert.equal(a.rttMs, 12);
  assert.equal(a.audio.packets, 5);
  const s = summarize(a, b);
  assert.equal(s.kbps, 4000, '500 bytes/ms = 4000 kbit/s');
  assert.equal(s.fps, 30);
  assert.equal(s.lossPct, 1, '1 lost of 100 received');
  assert.equal(summarize(null, b).kbps, null);
  assert.equal(summarize(null, readStats(new Map())).fps, null);
  assert.equal(linkQuality({ rttMs: 20, lossPct: 0 }), 'good');
  assert.equal(linkQuality({ rttMs: 200 }), 'fair');
  assert.equal(linkQuality({ lossPct: 3 }), 'fair');
  assert.equal(linkQuality({ macSaysSlow: true }), 'fair');
  assert.equal(linkQuality({ rttMs: 500 }), 'poor');
  assert.equal(linkQuality({ lossPct: 10 }), 'poor');
  const lines = Object.fromEntries(statsLines(s, { pingMs: 23.4, decoder: 'VideoToolbox' }));
  assert.equal(lines.Picture, '1440 × 900');
  assert.equal(lines['Frames a second'], '30');
  assert.equal(lines['Video data'], '4.0 Mbit/s');
  assert.equal(lines['Lost packets'], '1%');
  assert.equal(lines['Round trip'], '23 ms');
  assert.equal(lines.Decoder, 'VideoToolbox');
  assert.equal(Object.fromEntries(statsLines(summarize(null, readStats(new Map()))))['Round trip'], '–');
});

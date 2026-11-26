// Tiny headless-Chrome launcher + CDP client (flattened sessions) for Node 26 (global WebSocket, no deps).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function randomPort() { return 20000 + Math.floor(Math.random() * 30000); }

export async function launchChrome({ port = randomPort(), userDataDir, extraArgs = [], baseDir } = {}) {
  const dir = userDataDir || mkdtempSync(path.join(baseDir || tmpdir(), 'chrome-prof-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--metrics-recording-only',
    '--password-store=basic', '--use-mock-keychain',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,800',
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-10000); });
  let version;
  for (let i = 0; i < 100; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(100); }
  }
  if (!version) { proc.kill('SIGKILL'); throw new Error('Chrome did not start: ' + stderr.slice(-2000)); }
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.open();
  const close = async () => {
    try { await cdp.send('Browser.close'); } catch {}
    await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    try { cdp.ws.close(); } catch {}
    if (!userDataDir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
  return { proc, port, version, cdp, close, get stderr() { return stderr; } };
}

export class CDP {
  constructor(url) { this.url = url; this.id = 0; this.cbs = new Map(); this.listeners = new Set(); }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('CDP ws error'));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.cbs.has(m.id)) {
          const { resolve, reject, method } = this.cbs.get(m.id);
          this.cbs.delete(m.id);
          m.error ? reject(new Error(`${method}: ${m.error.message}${m.error.data ? ' ' + m.error.data : ''}`)) : resolve(m.result);
        } else if (m.method) {
          for (const l of [...this.listeners]) l(m);
        }
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.cbs.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(msg));
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  waitFor(pred, timeoutMs = 10000, what = 'event') {
    return new Promise((resolve, reject) => {
      const off = this.on((m) => { if (pred(m)) { clearTimeout(to); off(); resolve(m); } });
      const to = setTimeout(() => { off(); reject(new Error('timeout waiting for ' + what)); }, timeoutMs);
    });
  }
  /** Attach to a page target (flatten) and return a session helper. */
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return this.session(sessionId, targetId);
  }
  session(sessionId, targetId) {
    const cdp = this;
    return {
      sessionId, targetId,
      send: (m, p) => cdp.send(m, p, sessionId),
      on: (fn) => cdp.on((m) => { if (m.sessionId === sessionId) fn(m); }),
      async eval(expression, { awaitPromise = true, userGesture = false, timeoutMs = 60000 } = {}) {
        const r = await Promise.race([
          cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture }, sessionId),
          sleep(timeoutMs).then(() => { throw new Error('eval timeout: ' + expression.slice(0, 80)); }),
        ]);
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          throw new Error('page exception: ' + (d.exception?.description || d.exception?.value || d.text));
        }
        return r.result.value;
      },
      async navigate(url) {
        await cdp.send('Page.enable', {}, sessionId);
        const loaded = cdp.waitFor((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 15000, 'load ' + url);
        const r = await cdp.send('Page.navigate', { url }, sessionId);
        if (r.errorText) throw new Error('navigate ' + url + ': ' + r.errorText);
        await loaded;
      },
    };
  }
  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const s = await this.attach(targetId);
    await s.send('Runtime.enable');
    await s.send('Log.enable');
    if (url !== 'about:blank') await s.navigate(url);
    return s;
  }
}

/** Collect console + Log entries for a session into an array. */
export function collectConsole(session) {
  const logs = [];
  session.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    } else if (m.method === 'Log.entryAdded') {
      logs.push(`[log.${m.params.entry.level}/${m.params.entry.source}] ${m.params.entry.text}${m.params.entry.url ? ' @' + m.params.entry.url : ''}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  });
  return logs;
}

/**
 * Gives every page (and popup, and out-of-process frame) its own CDP virtual passkey authenticator before any of its
 * scripts run, so no WebAuthn request can ever reach the real Touch ID or iCloud Keychain. Credentials made in one
 * tab are copied into new tabs (with the current sign counter) so a passkey "syncs" like a real one.
 * Returns { sessions, credentials() }.
 */
export async function autoVirtualAuthenticator(cdp, { onSession } = {}) {
  const sessions = new Map(); // sessionId -> { session, authenticatorId }
  const known = new Map();    // credentialId -> credential (with private key)
  async function refresh() {
    for (const { session, authenticatorId } of sessions.values()) {
      try {
        const { credentials } = await session.send('WebAuthn.getCredentials', { authenticatorId });
        for (const c of credentials) known.set(c.credentialId, c);
      } catch {}
    }
  }
  cdp.on(async (m) => {
    if (m.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo, waitingForDebugger } = m.params;
    if (!['page', 'iframe'].includes(targetInfo.type)) {
      if (waitingForDebugger) cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      return;
    }
    const session = cdp.session(sessionId, targetInfo.targetId);
    try {
      await session.send('Runtime.enable');
      await session.send('Page.enable').catch(() => {});
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await session.send('WebAuthn.enable', { enableUI: false });
      const { authenticatorId } = await session.send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
          isUserVerified: true, automaticPresenceSimulation: true },
      });
      await refresh();
      for (const c of known.values()) {
        await session.send('WebAuthn.addCredential', { authenticatorId, credential: c }).catch(() => {});
      }
      sessions.set(sessionId, { session, authenticatorId });
      await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {});
      onSession?.(session, targetInfo);
    } catch {}
    if (waitingForDebugger) cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  return { sessions, async credentials() { await refresh(); return [...known.values()]; } };
}

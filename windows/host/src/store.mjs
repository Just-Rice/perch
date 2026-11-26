// Everything Roost remembers on this PC.
//
// config.json ($ROOST_HOME, mode 0600): the PC's id and name, settings, paired devices (public keys only), the
// backup sign-in verifier, lockout counters and a short activity log.
// Secrets (the rendezvous key, the authenticator secret, the backup sign-in server key) live in secrets.dpapi,
// encrypted with Windows' DPAPI for the signed-in user. The host never touches DPAPI itself: it asks roost.exe
// (`roost.exe --secrets read|write --home <dir>`, docs/WINDOWS-APP.md, "Secrets"). Tests, and development on a
// computer without roost.exe, keep them in plain secrets.json instead (ROOST_SECRETS=file).
// See docs/PROTOCOL.md, "Identities and secrets".
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { toB64url, fromB64url } from '../../site/js/shared/bytes.js';
import { HOST_ID_BYTES, SIG_KEY_BYTES, DEFAULT_QUALITY } from '../../site/js/shared/proto.js';
import { newMacName } from './names.mjs';
import { freshLimit } from './limits.mjs';

export const DPAPI_FILE = 'secrets.dpapi';
// roost.exe --secrets read: exit 3 means there is no secrets file yet (a first run, or after Start over).
const NO_SECRETS_YET = 3;
const SECRETS_TIMEOUT_MS = 15_000;
const LOG_KEEP = 200;

export const DEFAULT_SETTINGS = Object.freeze({
  loginItem: true,
  keepAwake: true,
  backupOn: false,
  idleMinutes: 60,
  paused: false,
  lockOnDisconnect: false,   // lock the PC when a viewer's session ends
  curtain: false,            // black out the PC's own screen while a viewer is connected
  micOutput: '',             // where a viewer's microphone is played: '' = the PC's current output, or a device UID
  quality: DEFAULT_QUALITY,
  // The 6-digit authenticator code, asked for after each of these (the owner can switch any of them off in Setup).
  codeWithPasskey: true,
  codeWithBackup: true,
  codeWithPairing: true,
  // Install a new version by itself once nobody has been connected for a couple of minutes (off: Setup and the menu
  // bar say when one is out, and the owner chooses when).
  autoUpdate: false,
  // Sound while someone is connected: the PC's own speakers (0–1; below 1 the PC's own speakers are turned down to
  // this level) and what is sent to the viewer (0–1.5). (macSpeakers keeps Roost's name: it is a wire field.)
  macSpeakers: 1,
  streamVolume: 1,
});

// Which code setting covers each route.
export const CODE_SETTING = Object.freeze({ passkey: 'codeWithPasskey', backup: 'codeWithBackup', pair: 'codeWithPairing' });

// Where Roost keeps its files: %LOCALAPPDATA%\Roost on Windows (the app passes the same as ROOST_HOME), ~/.roost
// anywhere else (development).
export function defaultHome(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'Roost');
  }
  return join(homedir(), '.roost');
}

// Runs `cmd args`, feeding it `input` on stdin. Resolves {code, stdout, stderr}, never rejects: code is the exit code,
// or a string such as 'ENOENT' when it couldn't start, or 'timeout'.
function run(cmd, args, input, execFileImpl = execFile) {
  return new Promise((resolve) => {
    const child = execFileImpl(cmd, args, { timeout: SECRETS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        code: !err ? 0 : err.killed ? 'timeout' : (err.code ?? 1),
        stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
      }));
    child.stdin?.on?.('error', () => {}); // a program that exits without reading stdin must not crash the host
    child.stdin?.end?.(input ?? '');
  });
}

// --- secret backends ---

// Secrets encrypted with DPAPI, through roost.exe. Reading fails loudly rather than returning nothing: an empty answer
// would make the store start a new identity and overwrite the real secrets, which would unpair every device.
export class DpapiSecrets {
  constructor({ exe, home, execFileImpl = execFile }) {
    if (!exe) throw new Error('DpapiSecrets needs the path of roost.exe');
    Object.assign(this, { exe, home, execFileImpl });
    this.path = join(home, DPAPI_FILE);
  }
  async read() {
    const r = await run(this.exe, ['--secrets', 'read', '--home', this.home], '', this.execFileImpl);
    if (r.code === NO_SECRETS_YET) return null;
    if (r.code !== 0) throw new Error(`could not read the secrets (roost.exe answered ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    try {
      const obj = JSON.parse(r.stdout);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch {}
    throw new Error('could not read the secrets: roost.exe sent something that isn\'t a secrets object');
  }
  async write(obj) {
    // The secrets go in on stdin, never on the command line, so they don't show up in the process list.
    const r = await run(this.exe, ['--secrets', 'write', '--home', this.home], JSON.stringify(obj), this.execFileImpl);
    if (r.code !== 0) throw new Error(`could not save the secrets (roost.exe answered ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
  }
  // roost.exe has no "remove": the file is useless without this user's DPAPI key, but it goes anyway.
  async remove() { rmSync(this.path, { force: true }); }
}

export class FileSecrets {
  constructor(home) { this.path = join(home, 'secrets.json'); }
  async read() {
    try { return JSON.parse(readFileSync(this.path, 'utf8')); } catch { return null; }
  }
  async write(obj) { writeAtomic(this.path, JSON.stringify(obj, null, 2)); }
  async remove() { rmSync(this.path, { force: true }); }
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// --- the store ---

export class Store {
  constructor(home, secretsBackend) {
    this.home = home;
    this.path = join(home, 'config.json');
    this.backend = secretsBackend;
    this.config = null;
    this.secrets = null;
  }

  // secrets: 'file' (secrets.json) or 'dpapi' (secrets.dpapi through roost.exe at `appExe`); see config.mjs.
  static async open({ home = defaultHome(), secrets = 'file', appExe = null, execFileImpl } = {}) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const backend = secrets === 'dpapi' ? new DpapiSecrets({ exe: appExe, home, execFileImpl }) : new FileSecrets(home);
    const store = new Store(home, backend);
    await store._load();
    return store;
  }

  async _load() {
    let cfg = null;
    if (existsSync(this.path)) {
      try { cfg = JSON.parse(readFileSync(this.path, 'utf8')); } catch { cfg = null; }
    }
    let sec = await this.backend.read();
    // A config without its secrets (or the reverse) can't be used: the rendezvous key is in every passkey.
    if (!cfg || cfg.v !== 1 || !sec?.sigKey) {
      cfg = {
        v: 1,
        hostId: toB64url(randomBytes(HOST_ID_BYTES)),
        macName: newMacName(),
        createdAt: new Date().toISOString(),
        settings: { ...DEFAULT_SETTINGS },
        devices: [],
        totp: { set: false, lastStep: -1, setAt: null },
        backup: { record: null, setAt: null },
        limits: { passkey: freshLimit(), backup: freshLimit() },
        log: [],
      };
      sec = { sigKey: toB64url(randomBytes(SIG_KEY_BYTES)), totpSecret: null, opaqueServerSetup: null };
      await this.backend.write(sec);
    }
    cfg.settings = { ...DEFAULT_SETTINGS, ...cfg.settings };
    cfg.limits = { passkey: freshLimit(), backup: freshLimit(), ...cfg.limits };
    this.config = cfg;
    this.secrets = sec;
    this.save();
  }

  save() {
    writeAtomic(this.path, JSON.stringify(this.config, null, 2));
  }

  async saveSecrets() {
    await this.backend.write(this.secrets);
  }

  // --- identity ---
  get hostId() { return fromB64url(this.config.hostId); }
  get sigKey() { return fromB64url(this.secrets.sigKey); }
  get macName() { return this.config.macName; }
  // The backup password is tied to the name (it is the OPAQUE user name), so a new name clears it.
  setMacName(name) {
    this.config.macName = name;
    this.config.backup = { record: null, setAt: null };
    this.config.settings.backupOn = false;
    this.save();
  }
  // The passkey user handle: hostId ‖ sigKey.
  // Passkeys made before one-tap sign-in carry just hostId ‖ sigKey (48 bytes).
  get legacyUserHandle() {
    const h = new Uint8Array(HOST_ID_BYTES + SIG_KEY_BYTES);
    h.set(this.hostId, 0);
    h.set(this.sigKey, HOST_ID_BYTES);
    return h;
  }
  // hostId ‖ sigKey ‖ the first 16 bytes of this PC's DTLS certificate fingerprint (64 bytes, WebAuthn's maximum):
  // the pin a browser checks before sending a one-tap sign-in. 48 bytes until the certificate exists.
  get userHandle() {
    const pin = this.dtlsPin;
    if (!pin) return this.legacyUserHandle;
    const h = new Uint8Array(HOST_ID_BYTES + SIG_KEY_BYTES + pin.length);
    h.set(this.legacyUserHandle, 0);
    h.set(pin, HOST_ID_BYTES + SIG_KEY_BYTES);
    return h;
  }

  // The PC's own DTLS certificate (it never changes, so passkeys can pin it). {certPem, keyPem, signatureHash}.
  get dtlsKeys() { return this.secrets.dtls ?? null; }
  async setDtlsKeys(keys, pin) {
    this.secrets.dtls = { certPem: keys.certPem, keyPem: keys.keyPem, signatureHash: keys.signatureHash, pin: toB64url(pin) };
    await this.saveSecrets();
  }
  get dtlsPin() { return this.secrets.dtls?.pin ? fromB64url(this.secrets.dtls.pin) : null; }

  // --- settings ---
  get settings() { return this.config.settings; }
  updateSettings(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS) || typeof v !== typeof DEFAULT_SETTINGS[k]) throw new Error(`bad setting ${k}`);
    }
    Object.assign(this.config.settings, patch);
    this.save();
    return this.config.settings;
  }

  // Is the 6-digit code asked for on this route? (Guests never get one: the link is their pass.)
  codeNeeded(route) { return route in CODE_SETTING ? this.settings[CODE_SETTING[route]] !== false : false; }
  // Is the authenticator app needed at all? Not when every code is switched off.
  get authenticatorNeeded() { return Object.values(CODE_SETTING).some(k => this.settings[k] !== false); }

  // --- authenticator app ---
  get totpSecret() { return this.secrets.totpSecret ? Buffer.from(fromB64url(this.secrets.totpSecret)) : null; }
  async setTotpSecret(bytes) {
    this.secrets.totpSecret = bytes ? toB64url(bytes) : null;
    await this.saveSecrets();
    this.config.totp = { set: !!bytes, lastStep: -1, setAt: bytes ? new Date().toISOString() : null };
    this.save();
  }
  markTotpUsed(step) {
    this.config.totp.lastStep = Math.max(this.config.totp.lastStep ?? -1, step);
    this.save();
  }

  // --- backup sign-in ---
  get opaqueServerSetup() { return this.secrets.opaqueServerSetup; }
  async setOpaqueServerSetup(s) { this.secrets.opaqueServerSetup = s; await this.saveSecrets(); }
  setBackupRecord(record) {
    this.config.backup = { record, setAt: record ? new Date().toISOString() : null };
    if (!record) this.config.settings.backupOn = false;
    this.save();
  }

  // --- the optional relay (Cloudflare TURN key; the token is a secret, so it lives with the other secrets) ---
  get relayLogin() { return this.secrets.relay ?? null; }
  async setRelayLogin(login) {
    this.secrets.relay = login ? { keyId: login.keyId, apiToken: login.apiToken } : null;
    await this.saveSecrets();
    this.config.relay = { set: !!login, setAt: login ? new Date().toISOString() : null };
    this.save();
  }

  // --- the optional Worker relay (the owner's own Cloudflare Worker; its secret lives with the other secrets) ---
  get workerRelay() { return this.secrets.workerRelay ?? null; }
  async setWorkerRelay(login) {
    this.secrets.workerRelay = login ? { url: login.url, secret: login.secret } : null;
    await this.saveSecrets();
    this.config.workerRelay = { set: !!login, url: login?.url ?? null, setAt: login ? new Date().toISOString() : null };
    this.save();
  }

  // A second relay holding the same secret (core/relay/node behind a tunnel), used while the first can't be reached.
  get workerRelayBackup() { return this.config.workerRelayBackup ?? null; }
  setWorkerRelayBackup(url) {
    this.config.workerRelayBackup = url ?? null;
    this.save();
  }
  // A relay on this PC (core/relay/node with QUICK_TUNNEL=1) whose public address changes; asked for it when needed.
  get workerRelayTunnel() { return this.config.workerRelayTunnel ?? null; }
  setWorkerRelayTunnel(url) {
    this.config.workerRelayTunnel = url ?? null;
    this.save();
  }

  // --- devices ---
  get devices() { return this.config.devices; }
  findDevice(id) { return this.config.devices.find(d => d.id === id) ?? null; }
  addDevice(dev) {
    this.config.devices = this.config.devices.filter(d => d.id !== dev.id);
    this.config.devices.push({ createdAt: new Date().toISOString(), lastUsedAt: null, ...dev });
    this.save();
  }
  updateDevice(id, patch) {
    const d = this.findDevice(id);
    if (!d) return null;
    Object.assign(d, patch);
    this.save();
    return d;
  }
  removeDevice(id) {
    const before = this.config.devices.length;
    this.config.devices = this.config.devices.filter(d => d.id !== id);
    this.save();
    return this.config.devices.length < before;
  }
  removeAllDevices() {
    this.config.devices = [];
    this.save();
  }

  // --- extra sites this PC accepts sign-ins from (the official site is always accepted) ---
  get sites() { return this.config.sites ?? []; }
  addSite(site) {
    this.config.sites = [...this.sites.filter(x => x.origin !== site.origin), { ...site, addedAt: new Date().toISOString() }];
    this.save();
  }
  removeSite(origin) {
    const before = this.sites.length;
    this.config.sites = this.sites.filter(x => x.origin !== origin);
    this.save();
    return this.config.sites.length < before;
  }

  // --- things Roost did by itself (restarting into an installed update, updating), so a failed try isn't repeated ---
  autoTriedRecently(kind, version, withinMs, now) {
    const last = this.config.autoTried?.[kind];
    return !!last && last.version === version && now - Date.parse(last.at) < withinMs;
  }
  noteAutoTry(kind, version, now) {
    this.config.autoTried = { ...this.config.autoTried, [kind]: { version, at: new Date(now).toISOString() } };
    this.save();
  }

  // --- lockouts ---
  limit(route) { return this.config.limits[route] ?? freshLimit(); }
  setLimit(route, value) { this.config.limits[route] = value; this.save(); }

  // --- activity log (sign-ins, failures, pairing) ---
  activity(kind, text) {
    this.config.log.push({ at: new Date().toISOString(), kind, text });
    if (this.config.log.length > LOG_KEEP) this.config.log.splice(0, this.config.log.length - LOG_KEEP);
    this.save();
  }

  // --- start over: new id, name and keys; every paired device stops working ---
  async reset() {
    await this.backend.remove();
    rmSync(this.path, { force: true });
    await this._load();
  }

  async destroy() {
    await this.backend.remove();
    rmSync(this.path, { force: true });
  }
}

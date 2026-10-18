// Everything Perch remembers on this Mac.
//
// config.json ($PERCH_HOME, mode 0600): the Mac's id and name, settings, paired devices (public keys only), the
// backup sign-in verifier, lockout counters and a short activity log.
// Secrets (the rendezvous key, the authenticator secret, the backup sign-in server key) live in the login Keychain,
// read and written through /usr/bin/security so app updates never trigger Keychain prompts — or in secrets.json
// when PERCH_SECRETS=file (tests). See docs/PROTOCOL.md, "Identities and secrets".
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { toB64url, fromB64url } from '../../../site/js/shared/bytes.js';
import { HOST_ID_BYTES, SIG_KEY_BYTES, DEFAULT_QUALITY } from '../../../site/js/shared/proto.js';
import { newMacName } from './names.mjs';
import { freshLimit } from './limits.mjs';

export const KEYCHAIN_SERVICE = 'io.github.just-rice.perch';
const KEYCHAIN_ACCOUNT = 'secrets';
const LOG_KEEP = 200;

export const DEFAULT_SETTINGS = Object.freeze({
  loginItem: true,
  keepAwake: true,
  backupOn: false,
  idleMinutes: 60,
  paused: false,
  quality: DEFAULT_QUALITY,
});

export function defaultHome() {
  return join(homedir(), 'Library', 'Application Support', 'Perch');
}

function run(cmd, args, input) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

// --- secret backends ---

export class KeychainSecrets {
  constructor(service = KEYCHAIN_SERVICE) { this.service = service; }
  async read() {
    const r = await run('/usr/bin/security', ['find-generic-password', '-s', this.service, '-a', KEYCHAIN_ACCOUNT, '-w']);
    if (r.code !== 0) return null; // 44 = not found
    try { return JSON.parse(r.stdout.trim()); } catch { return null; }
  }
  async write(obj) {
    // `security -i` reads the command from stdin, so the secret never appears in the process list. -X = hex data.
    const hex = Buffer.from(JSON.stringify(obj)).toString('hex');
    const r = await run('/usr/bin/security', ['-i'],
      `add-generic-password -U -s ${this.service} -a ${KEYCHAIN_ACCOUNT} -l Perch -X ${hex}\n`);
    if (r.code !== 0 || /error|SecKeychain/i.test(r.stderr)) throw new Error(`could not save to the Keychain: ${r.stderr.trim()}`);
  }
  async remove() {
    await run('/usr/bin/security', ['delete-generic-password', '-s', this.service, '-a', KEYCHAIN_ACCOUNT]);
  }
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

  static async open({ home = defaultHome(), secrets = 'keychain' } = {}) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const store = new Store(home, secrets === 'file' ? new FileSecrets(home) : new KeychainSecrets());
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
  get userHandle() {
    const h = new Uint8Array(HOST_ID_BYTES + SIG_KEY_BYTES);
    h.set(this.hostId, 0);
    h.set(this.sigKey, HOST_ID_BYTES);
    return h;
  }

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

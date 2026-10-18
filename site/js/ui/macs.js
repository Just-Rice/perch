// The Macs this browser knows how to reach: what a passkey sign-in needs to find the Mac (its hostId and rendezvous
// key, both also inside the passkey's user handle) plus which passkey to ask for and a name to show.
// Kept in localStorage under 'perch.macs.v1'. Storage can be missing or throw (private windows, blocked site data,
// some about:blank set-ups); then the list simply lives in memory for this visit.
import { fromB64url } from '../shared/bytes.js';
import { HOST_ID_BYTES, SIG_KEY_BYTES } from '../shared/proto.js';

export const MACS_KEY = 'perch.macs.v1';
const MAX_MACS = 20;

// localStorage, or a stand-in that keeps values in memory when the real one can't be used.
export function safeStorage(get = () => globalThis.localStorage) {
  try {
    const s = get();
    const probe = 'perch.probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    const mem = new Map();
    return {
      getItem: k => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: k => { mem.delete(k); },
      memoryOnly: true,
    };
  }
}

const bytesLen = (s, n) => {
  try { return fromB64url(s).length === n; } catch { return false; }
};

// Only well-formed entries survive: anything else in storage (an older format, a hand edit) is ignored.
export function validMac(m) {
  return !!m && typeof m === 'object' &&
    bytesLen(m.hostId, HOST_ID_BYTES) && bytesLen(m.sigKey, SIG_KEY_BYTES) &&
    typeof m.credentialId === 'string' && /^[A-Za-z0-9_-]{1,1400}$/.test(m.credentialId) &&
    (m.name === undefined || typeof m.name === 'string') &&
    (m.label === undefined || typeof m.label === 'string') &&
    (m.pin === undefined || bytesLen(m.pin, 16));
}

const clean = m => ({
  hostId: m.hostId,
  sigKey: m.sigKey,
  name: String(m.name || '').slice(0, 64),
  credentialId: m.credentialId,
  ...(m.label ? { label: String(m.label).slice(0, 64) } : {}),
  // The Mac's certificate pin (b64url of 16 bytes), when its passkey or pairing link carried one.
  ...(m.pin ? { pin: m.pin } : {}),
  lastUsed: Number.isFinite(m.lastUsed) ? m.lastUsed : 0,
});

export class MacStore {
  constructor(storage = safeStorage()) {
    this.storage = storage;
  }

  get persistent() { return !this.storage.memoryOnly; }

  // Newest first.
  list() {
    let raw;
    try { raw = JSON.parse(this.storage.getItem(MACS_KEY) || '[]'); } catch { raw = []; }
    if (!Array.isArray(raw)) raw = [];
    return raw.filter(validMac).map(clean).sort((a, b) => b.lastUsed - a.lastUsed);
  }

  get(hostId) { return this.list().find(m => m.hostId === hostId) || null; }

  // Adds a Mac or updates the one with the same hostId (one entry per Mac; the newest passkey wins).
  save(mac) {
    if (!validMac(mac)) throw new Error('not a valid Mac entry');
    const old = this.get(mac.hostId);
    const merged = clean({ ...old, ...mac, name: mac.name || old?.name || '' });
    const list = [merged, ...this.list().filter(m => m.hostId !== mac.hostId)].slice(0, MAX_MACS);
    this._write(list);
    return merged;
  }

  update(hostId, patch) {
    const old = this.get(hostId);
    return old ? this.save({ ...old, ...patch }) : null;
  }

  forget(hostId) {
    this._write(this.list().filter(m => m.hostId !== hostId));
  }

  _write(list) {
    try { this.storage.setItem(MACS_KEY, JSON.stringify(list)); } catch { /* full or blocked: keep going */ }
  }
}

// "Today", "Yesterday", "3 days ago" — for the list of Macs.
export function lastUsedText(ms, now = Date.now()) {
  if (!ms) return 'Not used yet';
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  if (ms >= t0) return 'Used today';
  if (ms >= t0 - day) return 'Used yesterday';
  const days = Math.ceil((t0 - ms) / day);
  if (days < 14) return `Used ${days} days ago`;
  if (days < 60) return `Used ${Math.round(days / 7)} weeks ago`;
  return `Used ${Math.round(days / 30)} months ago`;
}

// Small viewer preferences remembered in this browser: picture quality, "Ctrl acts as ⌘", the last backup Mac name,
// the volume. Nothing here is secret. Missing or blocked storage just means the defaults every time.
import { safeStorage } from './macs.js';
import { QUALITY, DEFAULT_QUALITY } from '../shared/proto.js';

export const PREFS_KEY = 'perch.prefs.v1';

export function defaultPrefs({ apple = false } = {}) {
  return { quality: DEFAULT_QUALITY, swapCtrlCmd: !apple, backupName: '', volume: 1, muted: false, stats: false };
}

export class Prefs {
  constructor({ storage = safeStorage(), apple = false } = {}) {
    this.storage = storage;
    this.values = defaultPrefs({ apple });
    // Only what the person chose is saved, so a default (like the Ctrl/⌘ swap, which depends on the keyboard) is
    // worked out afresh each time rather than frozen by an unrelated change such as the quality.
    this.chosen = {};
    try {
      const saved = JSON.parse(storage.getItem(PREFS_KEY) || '{}');
      if (saved && typeof saved === 'object') {
        this.chosen = { ...saved };
        if (saved.quality in QUALITY) this.values.quality = saved.quality;
        if (typeof saved.swapCtrlCmd === 'boolean') this.values.swapCtrlCmd = saved.swapCtrlCmd;
        if (typeof saved.backupName === 'string') this.values.backupName = saved.backupName.slice(0, 40);
        if (Number.isFinite(saved.volume)) this.values.volume = Math.min(1, Math.max(0, saved.volume));
        if (typeof saved.muted === 'boolean') this.values.muted = saved.muted;
        if (typeof saved.stats === 'boolean') this.values.stats = saved.stats;
      }
    } catch { /* keep the defaults */ }
  }
  get(k) { return this.values[k]; }
  set(k, v) {
    this.values[k] = v;
    this.chosen[k] = v;
    try { this.storage.setItem(PREFS_KEY, JSON.stringify(this.chosen)); } catch { /* not remembered, that's all */ }
  }
}

// Small viewer preferences remembered in this browser: picture quality, "Ctrl acts as ⌘", the last backup Mac name,
// the volume. Nothing here is secret. Missing or blocked storage just means the defaults every time.
import { safeStorage } from './macs.js';
import { QUALITY, DEFAULT_QUALITY } from '../shared/proto.js';

export const PREFS_KEY = 'perch.prefs.v1';

export function defaultPrefs({ apple = false } = {}) {
  return {
    quality: DEFAULT_QUALITY, swapCtrlCmd: !apple, backupName: '', volume: 1, muted: false, stats: false,
    captureOnClick: false, hideCursor: false,
    // The toolbar: which edge it sits on, where along that edge (0..1), and whether it hides itself when not in use
    // (otherwise it stays put and the Mac's picture makes room for it).
    tbEdge: 'top', tbPos: 0.5, tbAutoHide: null, // null: hide on touch screens only
    keysBar: null, customKeys: [], swipe: 'apps',
  };
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
        for (const k of ['captureOnClick', 'hideCursor', 'tbAutoHide']) if (typeof saved[k] === 'boolean') this.values[k] = saved[k];
        if (['top', 'bottom', 'left', 'right'].includes(saved.tbEdge)) this.values.tbEdge = saved.tbEdge;
        if (Number.isFinite(saved.tbPos)) this.values.tbPos = Math.min(1, Math.max(0, saved.tbPos));
        if (Array.isArray(saved.keysBar)) this.values.keysBar = saved.keysBar.slice(0, 80);
        if (Array.isArray(saved.customKeys)) this.values.customKeys = saved.customKeys.slice(0, 40);
        if (typeof saved.swipe === 'string') this.values.swipe = saved.swipe;
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

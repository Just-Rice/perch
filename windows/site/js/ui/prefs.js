// Small viewer preferences remembered in this browser: picture quality, "⌘ is Ctrl", the last backup PC name, the
// volume, where the Dock sits, the Key deck. Nothing here is secret. Missing or blocked storage just means the
// defaults every time.
import { safeStorage } from './macs.js';
import { QUALITY, DEFAULT_QUALITY } from '../shared/proto.js';
import { isAnchor } from '../viewer/dock.js';

export const PREFS_KEY = 'roost.prefs.v1';
const IDLE = ['stay', 'orb', 'hide'];

export function defaultPrefs({ apple = false } = {}) {
  return {
    // "⌘ is Ctrl": an Apple keyboard's ⌘ goes to the PC as Ctrl (so ⌘C copies there), and Control as the Windows key.
    quality: DEFAULT_QUALITY, swapCtrlCmd: apple, backupName: '', volume: 1, muted: false, stats: false,
    captureOnClick: false, hideCursor: false, touchpad: false,
    // The Dock: where it sits (one of dock.js ANCHORS), what it does when not in use ('stay', 'orb' or 'hide'), whether
    // the picture keeps clear of it, and whether it was shrunk to the orb by hand. null: the device decides (a mouse:
    // at the top, staying, picture clear of it; a touch screen: at the bottom, shrinking to the orb).
    dockAt: null, dockIdle: null, dockRoom: null, dockOrb: false, dockNoted: false,
    keysBar: null, customKeys: [], swipe: 'apps',
    clipSync: true, // what's copied on the PC lands on this device's clipboard by itself
    shape: 'fit', // the picture on this screen: 'fit' (whole, bars where the shapes differ), 'fill' or 'stretch'
    mouseSpeed: 1, // a captured mouse: how far it moves the PC's pointer (0.2 to 2, 1 = as on this screen)
  };
}

export class Prefs {
  constructor({ storage = safeStorage(), apple = false } = {}) {
    this.storage = storage;
    this.values = defaultPrefs({ apple });
    // Only what the person chose is saved, so a default (like "⌘ is Ctrl", which depends on the keyboard) is worked out
    // afresh each time rather than frozen by an unrelated change such as the quality.
    this.chosen = {};
    try {
      const saved = JSON.parse(storage.getItem(PREFS_KEY) || '{}');
      if (saved && typeof saved === 'object') {
        this.chosen = { ...saved };
        if (saved.quality in QUALITY) this.values.quality = saved.quality;
        if (typeof saved.backupName === 'string') this.values.backupName = saved.backupName.slice(0, 40);
        if (Number.isFinite(saved.volume)) this.values.volume = Math.min(1, Math.max(0, saved.volume));
        for (const k of ['swapCtrlCmd', 'muted', 'stats', 'captureOnClick', 'hideCursor', 'touchpad', 'clipSync', 'dockRoom',
          'dockOrb', 'dockNoted']) if (typeof saved[k] === 'boolean') this.values[k] = saved[k];
        if (isAnchor(saved.dockAt)) this.values.dockAt = saved.dockAt;
        if (IDLE.includes(saved.dockIdle)) this.values.dockIdle = saved.dockIdle;
        if (Array.isArray(saved.keysBar)) this.values.keysBar = saved.keysBar.slice(0, 80);
        if (Array.isArray(saved.customKeys)) this.values.customKeys = saved.customKeys.slice(0, 40);
        if (typeof saved.swipe === 'string') this.values.swipe = saved.swipe;
        if (['fit', 'fill', 'stretch'].includes(saved.shape)) this.values.shape = saved.shape;
        if (Number.isFinite(saved.mouseSpeed)) this.values.mouseSpeed = Math.min(2, Math.max(0.2, saved.mouseSpeed));
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

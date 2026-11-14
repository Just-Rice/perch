// The keys bar's buttons: a catalog of Mac keys and shortcuts to choose from, the person's own shortcuts, and which
// of them are on the bar. Pure functions only (tested in Node); viewer/viewer.js draws the bar and the editor.
import { SHIFT, CTRL, ALT, META } from './keys.js';

const k = (id, label, title, code, key, m = 0, group = 'Keys') => ({ id, label, title, code, key, m, group });

export const GROUPS = ['Keys', 'Switching', 'Editing', 'Browser', 'System', 'Function keys'];

export const CATALOG = [
  k('esc', 'esc', 'Escape', 'Escape', 'Escape'),
  k('tab', 'tab', 'Tab', 'Tab', 'Tab'),
  k('left', '←', 'Left arrow', 'ArrowLeft', 'ArrowLeft'),
  k('up', '↑', 'Up arrow', 'ArrowUp', 'ArrowUp'),
  k('down', '↓', 'Down arrow', 'ArrowDown', 'ArrowDown'),
  k('right', '→', 'Right arrow', 'ArrowRight', 'ArrowRight'),
  k('delete', '⌫', 'Delete', 'Backspace', 'Backspace'),
  k('fwdDelete', '⌦', 'Forward delete', 'Delete', 'Delete'),
  k('enter', 'return', 'Return', 'Enter', 'Enter'),
  k('space', 'space', 'Space bar', 'Space', ' '),
  k('home', 'home', 'Home', 'Home', 'Home'),
  k('end', 'end', 'End', 'End', 'End'),
  k('pageUp', 'pg up', 'Page up', 'PageUp', 'PageUp'),
  k('pageDown', 'pg dn', 'Page down', 'PageDown', 'PageDown'),

  k('cmdTab', '⌘ Tab', 'Switch apps', 'Tab', 'Tab', META, 'Switching'),
  k('cmdShiftTab', '⌘⇧ Tab', 'Switch apps, backwards', 'Tab', 'Tab', META | SHIFT, 'Switching'),
  k('nextWindow', '⌘`', 'Next window of this app', 'Backquote', '`', META, 'Switching'),
  k('prevWindow', '⌘⇧`', 'Previous window of this app', 'Backquote', '~', META | SHIFT, 'Switching'),
  k('spaceLeft', '⌃←', 'Desktop or full-screen app to the left', 'ArrowLeft', 'ArrowLeft', CTRL, 'Switching'),
  k('spaceRight', '⌃→', 'Desktop or full-screen app to the right', 'ArrowRight', 'ArrowRight', CTRL, 'Switching'),
  k('missionControl', 'Mission Control', 'Mission Control (⌃↑)', 'ArrowUp', 'ArrowUp', CTRL, 'Switching'),
  k('appWindows', 'App windows', "All of this app's windows (⌃↓)", 'ArrowDown', 'ArrowDown', CTRL, 'Switching'),
  k('showDesktop', 'Desktop', 'Show the desktop (F11)', 'F11', 'F11', 0, 'Switching'),
  k('dock', 'Dock', 'Show the Dock (⌃F3)', 'F3', 'F3', CTRL, 'Switching'),
  k('minimize', '⌘M', 'Minimize window', 'KeyM', 'm', META, 'Switching'),
  k('hide', '⌘H', 'Hide this app', 'KeyH', 'h', META, 'Switching'),
  k('fullScreenApp', '⌃⌘F', 'Full screen on or off', 'KeyF', 'f', META | CTRL, 'Switching'),
  k('cmdW', '⌘W', 'Close window or tab', 'KeyW', 'w', META, 'Switching'),
  k('cmdQ', '⌘Q', 'Quit app', 'KeyQ', 'q', META, 'Switching'),

  k('copy', '⌘C', 'Copy', 'KeyC', 'c', META, 'Editing'),
  k('paste', '⌘V', 'Paste', 'KeyV', 'v', META, 'Editing'),
  k('cut', '⌘X', 'Cut', 'KeyX', 'x', META, 'Editing'),
  k('undo', '⌘Z', 'Undo', 'KeyZ', 'z', META, 'Editing'),
  k('redo', '⌘⇧Z', 'Redo', 'KeyZ', 'Z', META | SHIFT, 'Editing'),
  k('selectAll', '⌘A', 'Select all', 'KeyA', 'a', META, 'Editing'),
  k('find', '⌘F', 'Find', 'KeyF', 'f', META, 'Editing'),
  k('save', '⌘S', 'Save', 'KeyS', 's', META, 'Editing'),
  k('emoji', 'Emoji', 'Emoji & symbols (⌃⌘Space)', 'Space', ' ', META | CTRL, 'Editing'),

  k('nextTab', 'Tab →', 'Next tab (⌃Tab)', 'Tab', 'Tab', CTRL, 'Browser'),
  k('prevTab', '← Tab', 'Previous tab (⌃⇧Tab)', 'Tab', 'Tab', CTRL | SHIFT, 'Browser'),
  k('newTab', '⌘T', 'New tab', 'KeyT', 't', META, 'Browser'),
  k('reopenTab', '⌘⇧T', 'Reopen closed tab', 'KeyT', 'T', META | SHIFT, 'Browser'),
  k('newWindow', '⌘N', 'New window', 'KeyN', 'n', META, 'Browser'),
  k('reload', '⌘R', 'Reload', 'KeyR', 'r', META, 'Browser'),
  k('back', '⌘[', 'Back', 'BracketLeft', '[', META, 'Browser'),
  k('forward', '⌘]', 'Forward', 'BracketRight', ']', META, 'Browser'),
  k('address', '⌘L', 'Address bar', 'KeyL', 'l', META, 'Browser'),

  k('forceQuit', 'Force Quit', 'Force Quit menu (⌘⌥Esc)', 'Escape', 'Escape', META | ALT, 'System'),
  k('spotlight', 'Spotlight', 'Spotlight (⌘ Space)', 'Space', ' ', META, 'System'),
  k('screenshot', '⌘⇧4', 'Screenshot of an area', 'Digit4', '$', META | SHIFT, 'System'),
  k('screenshotTool', '⌘⇧5', 'Screenshot and recording tools', 'Digit5', '%', META | SHIFT, 'System'),
  k('lock', 'Lock', 'Lock the screen (⌃⌘Q)', 'KeyQ', 'q', META | CTRL, 'System'),
  k('settings', '⌘,', "This app's settings", 'Comma', ',', META, 'System'),

  ...Array.from({ length: 12 }, (_, i) => k(`f${i + 1}`, `F${i + 1}`, `F${i + 1}`, `F${i + 1}`, `F${i + 1}`, 0, 'Function keys')),
];

const BY_ID = new Map(CATALOG.map(s => [s.id, s]));

// What the bar shows until the person changes it (what it always showed).
export const DEFAULT_BAR = ['esc', 'tab', 'left', 'up', 'down', 'right', 'delete', 'cmdTab', 'missionControl', 'spotlight', 'cmdW', 'cmdQ'];
export const FUNCTION_KEYS = CATALOG.filter(s => s.group === 'Function keys').map(s => s.id);

// Keys a homemade shortcut can press, as [code, key, label].
export const CUSTOM_KEYS = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => [`Key${c}`, c.toLowerCase(), c]),
  ...'0123456789'.split('').map(c => [`Digit${c}`, c, c]),
  ...Array.from({ length: 20 }, (_, i) => [`F${i + 1}`, `F${i + 1}`, `F${i + 1}`]),
  ['Escape', 'Escape', 'esc'], ['Tab', 'Tab', 'tab'], ['Space', ' ', 'space'], ['Enter', 'Enter', 'return'],
  ['Backspace', 'Backspace', '⌫'], ['Delete', 'Delete', '⌦'],
  ['ArrowLeft', 'ArrowLeft', '←'], ['ArrowRight', 'ArrowRight', '→'], ['ArrowUp', 'ArrowUp', '↑'], ['ArrowDown', 'ArrowDown', '↓'],
  ['Home', 'Home', 'home'], ['End', 'End', 'end'], ['PageUp', 'PageUp', 'pg up'], ['PageDown', 'PageDown', 'pg dn'],
  ['Backquote', '`', '`'], ['Minus', '-', '-'], ['Equal', '=', '='], ['BracketLeft', '[', '['], ['BracketRight', ']', ']'],
  ['Backslash', '\\', '\\'], ['Semicolon', ';', ';'], ['Quote', "'", "'"], ['Comma', ',', ','], ['Period', '.', '.'],
  ['Slash', '/', '/'],
];
const CUSTOM_BY_CODE = new Map(CUSTOM_KEYS.map(c => [c[0], c]));

// ⌃⌥⇧⌘ in the order Macs write them.
export function modLabel(m) {
  return (m & CTRL ? '⌃' : '') + (m & ALT ? '⌥' : '') + (m & SHIFT ? '⇧' : '') + (m & META ? '⌘' : '');
}

// A homemade shortcut from the editor's choices, or null if it isn't one (no such key).
export function makeCustom(code, m, label = '') {
  const c = CUSTOM_BY_CODE.get(code);
  if (!c || !Number.isInteger(m) || m < 0 || m > 15) return null;
  const name = String(label).trim().slice(0, 16);
  const combo = modLabel(m) + (c[2].length > 1 && m ? ' ' : '') + c[2];
  return { id: `c:${modLabel(m)}${code}`, name, label: name || combo, title: name ? `${name} (${combo})` : combo, code, key: c[1], m, group: 'Yours' };
}

// Saved homemade shortcuts, cleaned: anything malformed (an old or edited save) is dropped.
export function cleanCustom(list) {
  if (!Array.isArray(list)) return [];
  const out = [], seen = new Set();
  for (const s of list.slice(0, 40)) {
    const c = s && makeCustom(s.code, s.m, typeof s.name === 'string' ? s.name : '');
    if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}

// The shortcut behind an id: from the catalog, or one of the person's own.
export function findShortcut(id, custom = []) {
  return BY_ID.get(id) ?? custom.find(s => s.id === id) ?? null;
}

// The saved bar, cleaned: known ids only, each once. Missing or broken → the default bar.
export function cleanBar(ids, custom = []) {
  if (!Array.isArray(ids)) return [...DEFAULT_BAR];
  const out = [];
  for (const id of ids) if (typeof id === 'string' && !out.includes(id) && findShortcut(id, custom)) out.push(id);
  return out;
}

// Turning one button on (added at the end) or off.
export function toggleOnBar(bar, id, on) {
  const rest = bar.filter(x => x !== id);
  return on ? [...rest, id] : rest;
}

// --- swipes: a swipe sideways (two fingers on a touchpad, three on a touch screen) switches things on the Mac ---

export const SWIPE_ACTIONS = {
  apps: { label: 'Switch apps (⌘Tab)' },
  spaces: { label: 'Switch desktops and full-screen apps (⌃← ⌃→)', next: 'spaceRight', prev: 'spaceLeft' },
  windows: { label: "Switch this app's windows (⌘`)", next: 'nextWindow', prev: 'prevWindow' },
  tabs: { label: 'Switch browser tabs (⌃Tab)', next: 'nextTab', prev: 'prevTab' },
  off: { label: 'Nothing (scroll sideways)' },
};
export const DEFAULT_SWIPE = 'apps';

// Two-finger swipes on a touchpad arrive as sideways wheel events. One that is clearly sideways and long enough is a
// swipe (fired once, then the rest of that gesture is swallowed); anything else is scrolling and is passed on.
export const SWIPE = Object.freeze({ GAP_MS: 220, DISTANCE_PX: 140, SIDEWAYS: 1.5 });

export class SwipeDetector {
  constructor(options = {}) {
    this.o = { ...SWIPE, ...options };
    this.reset();
  }
  reset() { this.sum = 0; this.fired = false; this.last = -Infinity; }
  // One wheel event (pixels, positive dx = scrolling right). Returns {pass: true} to scroll as usual, or
  // {pass: false, swipe: +1 | -1 | 0} (+1 next, -1 previous, 0 nothing yet) when it is part of a swipe.
  wheel(dx, dy, t) {
    if (t - this.last > this.o.GAP_MS) this.reset();
    this.last = t;
    const sideways = Math.abs(dx) > Math.abs(dy) * this.o.SIDEWAYS;
    if (!sideways && !this.fired && this.sum === 0) return { pass: true };
    if (!sideways) return { pass: !this.fired, swipe: 0 };
    if (this.fired) return { pass: false, swipe: 0 };
    this.sum += dx;
    if (Math.abs(this.sum) < this.o.DISTANCE_PX) return { pass: false, swipe: 0 };
    this.fired = true;
    return { pass: false, swipe: Math.sign(this.sum) };
  }
}

// The Key deck's buttons: a catalog of the PC's keys and Windows shortcuts to choose from, the person's own shortcuts,
// and which of them are on the deck. Pure functions only (tested in Node); viewer/viewer.js draws the deck, the
// editor and the Command palette's "Press …" entries from the same list.
import { SHIFT, CTRL, ALT, META } from './keys.js';

const k = (id, label, title, code, key, m = 0, group = 'Keys') => ({ id, label, title, code, key, m, group });

export const GROUPS = ['Keys', 'Windows', 'Editing', 'Browser', 'System', 'PC controls', 'Function keys'];
// The PC's special keys: not shortcuts but keys of their own, pressed by the Roost app (only brightness on Windows:
// a viewer never makes the PC itself play sound, so no volume or media keys).
const sys = (id, label, title, key) => ({ id, label, title, sys: key, code: '', key: '', m: 0, group: 'PC controls' });

export const CATALOG = [
  k('esc', 'Esc', 'Escape', 'Escape', 'Escape'),
  k('tab', 'Tab', 'Tab', 'Tab', 'Tab'),
  k('left', '←', 'Left arrow', 'ArrowLeft', 'ArrowLeft'),
  k('up', '↑', 'Up arrow', 'ArrowUp', 'ArrowUp'),
  k('down', '↓', 'Down arrow', 'ArrowDown', 'ArrowDown'),
  k('right', '→', 'Right arrow', 'ArrowRight', 'ArrowRight'),
  k('delete', '⌫', 'Backspace', 'Backspace', 'Backspace'),
  k('fwdDelete', 'Del', 'Delete', 'Delete', 'Delete'),
  k('enter', 'Enter', 'Enter', 'Enter', 'Enter'),
  k('space', 'Space', 'Space bar', 'Space', ' '),
  k('home', 'Home', 'Home', 'Home', 'Home'),
  k('end', 'End', 'End', 'End', 'End'),
  k('pageUp', 'PgUp', 'Page up', 'PageUp', 'PageUp'),
  k('pageDown', 'PgDn', 'Page down', 'PageDown', 'PageDown'),
  k('insert', 'Ins', 'Insert', 'Insert', 'Insert'),
  k('printScreen', 'PrtSc', 'Print Screen', 'PrintScreen', 'PrintScreen'),

  k('start', 'Start', 'Start menu (Win)', 'MetaLeft', 'Meta', 0, 'Windows'),
  k('altTab', 'Alt+Tab', 'Switch apps', 'Tab', 'Tab', ALT, 'Windows'),
  k('altShiftTab', 'Alt+Shift+Tab', 'Switch apps, backwards', 'Tab', 'Tab', ALT | SHIFT, 'Windows'),
  k('taskView', 'Task View', 'Task View (Win+Tab)', 'Tab', 'Tab', META, 'Windows'),
  k('showDesktop', 'Desktop', 'Show the desktop (Win+D)', 'KeyD', 'd', META, 'Windows'),
  k('desktopLeft', 'Desktop ←', 'Virtual desktop to the left (Win+Ctrl+←)', 'ArrowLeft', 'ArrowLeft', META | CTRL, 'Windows'),
  k('desktopRight', 'Desktop →', 'Virtual desktop to the right (Win+Ctrl+→)', 'ArrowRight', 'ArrowRight', META | CTRL, 'Windows'),
  k('snapLeft', 'Snap ←', 'Snap window left (Win+←)', 'ArrowLeft', 'ArrowLeft', META, 'Windows'),
  k('snapRight', 'Snap →', 'Snap window right (Win+→)', 'ArrowRight', 'ArrowRight', META, 'Windows'),
  k('maximize', 'Maximize', 'Maximize window (Win+↑)', 'ArrowUp', 'ArrowUp', META, 'Windows'),
  k('minimize', 'Minimize', 'Minimize window (Win+↓)', 'ArrowDown', 'ArrowDown', META, 'Windows'),
  k('minimizeAll', 'Win+M', 'Minimize all windows', 'KeyM', 'm', META, 'Windows'),
  k('closeApp', 'Alt+F4', 'Close the app', 'F4', 'F4', ALT, 'Windows'),
  k('closeTab', 'Ctrl+W', 'Close window or tab', 'KeyW', 'w', CTRL, 'Windows'),
  k('explorer', 'Win+E', 'File Explorer', 'KeyE', 'e', META, 'Windows'),

  k('copy', 'Ctrl+C', 'Copy', 'KeyC', 'c', CTRL, 'Editing'),
  k('paste', 'Ctrl+V', 'Paste', 'KeyV', 'v', CTRL, 'Editing'),
  k('cut', 'Ctrl+X', 'Cut', 'KeyX', 'x', CTRL, 'Editing'),
  k('undo', 'Ctrl+Z', 'Undo', 'KeyZ', 'z', CTRL, 'Editing'),
  k('redo', 'Ctrl+Y', 'Redo', 'KeyY', 'y', CTRL, 'Editing'),
  k('selectAll', 'Ctrl+A', 'Select all', 'KeyA', 'a', CTRL, 'Editing'),
  k('find', 'Ctrl+F', 'Find', 'KeyF', 'f', CTRL, 'Editing'),
  k('save', 'Ctrl+S', 'Save', 'KeyS', 's', CTRL, 'Editing'),
  k('clipHistory', 'Win+V', 'Clipboard history', 'KeyV', 'v', META, 'Editing'),
  k('emoji', 'Emoji', 'Emoji and symbols (Win+.)', 'Period', '.', META, 'Editing'),

  k('nextTab', 'Tab →', 'Next tab (Ctrl+Tab)', 'Tab', 'Tab', CTRL, 'Browser'),
  k('prevTab', '← Tab', 'Previous tab (Ctrl+Shift+Tab)', 'Tab', 'Tab', CTRL | SHIFT, 'Browser'),
  k('newTab', 'Ctrl+T', 'New tab', 'KeyT', 't', CTRL, 'Browser'),
  k('reopenTab', 'Ctrl+Shift+T', 'Reopen closed tab', 'KeyT', 'T', CTRL | SHIFT, 'Browser'),
  k('newWindow', 'Ctrl+N', 'New window', 'KeyN', 'n', CTRL, 'Browser'),
  k('reload', 'F5', 'Reload', 'F5', 'F5', 0, 'Browser'),
  k('back', 'Alt+←', 'Back', 'ArrowLeft', 'ArrowLeft', ALT, 'Browser'),
  k('forward', 'Alt+→', 'Forward', 'ArrowRight', 'ArrowRight', ALT, 'Browser'),
  k('address', 'Ctrl+L', 'Address bar', 'KeyL', 'l', CTRL, 'Browser'),

  // Ctrl+Alt+Del and Win+L can't be pressed by any program (Windows keeps them for itself): Task Manager stands in.
  k('taskManager', 'Task Manager', 'Task Manager (Ctrl+Shift+Esc)', 'Escape', 'Escape', CTRL | SHIFT, 'System'),
  k('search', 'Search', 'Search (Win+S)', 'KeyS', 's', META, 'System'),
  k('run', 'Run', 'Run a command (Win+R)', 'KeyR', 'r', META, 'System'),
  k('settings', 'Settings', 'Windows Settings (Win+I)', 'KeyI', 'i', META, 'System'),
  k('snip', 'Snip', 'Snipping Tool: screenshot of an area (Win+Shift+S)', 'KeyS', 'S', META | SHIFT, 'System'),
  k('quickLink', 'Win+X', 'Quick Link menu', 'KeyX', 'x', META, 'System'),
  k('notifications', 'Win+N', 'Notifications', 'KeyN', 'n', META, 'System'),
  k('quickSettings', 'Win+A', 'Quick Settings', 'KeyA', 'a', META, 'System'),
  k('contextMenu', 'Menu', 'Right-click menu (Shift+F10)', 'F10', 'F10', SHIFT, 'System'),

  sys('brightnessUp', 'Bright +', 'Screen brighter', 'brightnessUp'),
  sys('brightnessDown', 'Bright −', 'Screen dimmer', 'brightnessDown'),

  ...Array.from({ length: 12 }, (_, i) => k(`f${i + 1}`, `F${i + 1}`, `F${i + 1}`, `F${i + 1}`, `F${i + 1}`, 0, 'Function keys')),
];

const BY_ID = new Map(CATALOG.map(s => [s.id, s]));

// What the deck shows until the person changes it.
export const DEFAULT_BAR = ['esc', 'tab', 'left', 'up', 'down', 'right', 'delete', 'start', 'altTab', 'taskView', 'showDesktop',
  'closeApp', 'taskManager'];
export const FUNCTION_KEYS = CATALOG.filter(s => s.group === 'Function keys').map(s => s.id);

// Keys a homemade shortcut can press, as [code, key, label].
export const CUSTOM_KEYS = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => [`Key${c}`, c.toLowerCase(), c]),
  ...'0123456789'.split('').map(c => [`Digit${c}`, c, c]),
  ...Array.from({ length: 20 }, (_, i) => [`F${i + 1}`, `F${i + 1}`, `F${i + 1}`]),
  ['Escape', 'Escape', 'Esc'], ['Tab', 'Tab', 'Tab'], ['Space', ' ', 'Space'], ['Enter', 'Enter', 'Enter'],
  ['Backspace', 'Backspace', '⌫'], ['Delete', 'Delete', 'Del'], ['Insert', 'Insert', 'Ins'], ['PrintScreen', 'PrintScreen', 'PrtSc'],
  ['ArrowLeft', 'ArrowLeft', '←'], ['ArrowRight', 'ArrowRight', '→'], ['ArrowUp', 'ArrowUp', '↑'], ['ArrowDown', 'ArrowDown', '↓'],
  ['Home', 'Home', 'Home'], ['End', 'End', 'End'], ['PageUp', 'PageUp', 'PgUp'], ['PageDown', 'PageDown', 'PgDn'],
  ['Backquote', '`', '`'], ['Minus', '-', '-'], ['Equal', '=', '='], ['BracketLeft', '[', '['], ['BracketRight', ']', ']'],
  ['Backslash', '\\', '\\'], ['Semicolon', ';', ';'], ['Quote', "'", "'"], ['Comma', ',', ','], ['Period', '.', '.'],
  ['Slash', '/', '/'],
];
const CUSTOM_BY_CODE = new Map(CUSTOM_KEYS.map(c => [c[0], c]));

// "Win+Ctrl+Alt+Shift+", in the order Windows writes them.
export function modLabel(m) {
  return (m & META ? 'Win+' : '') + (m & CTRL ? 'Ctrl+' : '') + (m & ALT ? 'Alt+' : '') + (m & SHIFT ? 'Shift+' : '');
}

// A homemade shortcut from the editor's choices, or null if it isn't one (no such key).
export function makeCustom(code, m, label = '') {
  const c = CUSTOM_BY_CODE.get(code);
  if (!c || !Number.isInteger(m) || m < 0 || m > 15) return null;
  const name = String(label).trim().slice(0, 16);
  const combo = modLabel(m) + c[2];
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

// --- swipes: a swipe sideways (two fingers on a touchpad, three on a touch screen) switches things on the PC ---
// (Up and down: Task View and the desktop, in viewer.js.)

export const SWIPE_ACTIONS = {
  apps: { label: 'Switch apps (Alt+Tab)' },
  desktops: { label: 'Switch virtual desktops (Win+Ctrl+← →)', next: 'desktopRight', prev: 'desktopLeft' },
  tabs: { label: 'Switch browser tabs (Ctrl+Tab)', next: 'nextTab', prev: 'prevTab' },
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

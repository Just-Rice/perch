// Keyboard messages for the Mac: `{t:"k", c, k, d, m}` with the DOM `code` (which physical key, US layout positions),
// the DOM `key`, down or up, and a modifier bitmask (docs/PROTOCOL.md, "Input and pointer channels").
// Pure functions only, so they can be tested in Node; viewer/keyboard.js attaches them to the page.

export const SHIFT = 1, CTRL = 2, ALT = 4, META = 8;

export function modifierBits(e) {
  return (e.shiftKey ? SHIFT : 0) | (e.ctrlKey ? CTRL : 0) | (e.altKey ? ALT : 0) | (e.metaKey ? META : 0);
}

// Old Firefox versions call the ⌘/Windows key "OS".
const CODE_ALIASES = { OSLeft: 'MetaLeft', OSRight: 'MetaRight' };
const SWAP_CODES = { ControlLeft: 'MetaLeft', ControlRight: 'MetaRight', MetaLeft: 'ControlLeft', MetaRight: 'ControlRight' };
const SWAP_KEYS = { Control: 'Meta', Meta: 'Control' };

const swapBits = m => (m & ~(CTRL | META)) | (m & CTRL ? META : 0) | (m & META ? CTRL : 0);

const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock',
]);
export const isModifierCode = code => MODIFIER_CODES.has(code);

// Turns a keydown/keyup event (anything with code, key, type and the modifier flags) into a message, or null for
// events the Mac shouldn't get: keys typed into an input method (Japanese, Chinese, phone keyboards), whose result
// arrives as text instead, and events with no physical key at all.
// `swapCtrlCmd`: on Windows, Linux and ChromeOS keyboards Control sits where ⌘ is on a Mac and people expect Ctrl+C to
// copy, so Control and ⌘ trade places (on by default there, off for Apple devices; see ui/prefs.js).
export function keyMessage(e, { swapCtrlCmd = false } = {}) {
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return null;
  let code = CODE_ALIASES[e.code] || e.code;
  if (!code || code === 'Unidentified') return null;
  let key = typeof e.key === 'string' ? e.key : '';
  let m = modifierBits(e);
  if (swapCtrlCmd) {
    code = SWAP_CODES[code] || code;
    key = SWAP_KEYS[key] || key;
    m = swapBits(m);
  }
  return { t: 'k', c: code, k: key, d: e.type === 'keydown', m };
}

// Remembers which keys the Mac currently thinks are held, to fix two things browsers get wrong:
// - on a Mac viewer, macOS never sends keyup for a key pressed while ⌘ is held (⌘C gives "C down" only), which would
//   leave C stuck down on the remote Mac; so letting go of ⌘ also lets go of everything pressed with it;
// - a keyup for a key the Mac never saw go down (pressed before the viewer had focus) is dropped.
export class HeldKeys {
  constructor() { this.held = new Map(); } // code -> key
  // Returns the messages to send for one key message.
  handle(msg) {
    if (msg.d) {
      this.held.set(msg.c, msg.k);
      return [msg];
    }
    if (!this.held.has(msg.c)) return [];
    this.held.delete(msg.c);
    const out = [msg];
    if (msg.c === 'MetaLeft' || msg.c === 'MetaRight') {
      for (const [code, key] of this.held) {
        if (isModifierCode(code)) continue;
        this.held.delete(code);
        out.push({ t: 'k', c: code, k: key, d: false, m: msg.m });
      }
    }
    return out;
  }
  // Forget everything (after sending {t:"rel"}, which makes the Mac let go of every key and button).
  clear() { this.held.clear(); }
  get size() { return this.held.size; }
}

// --- presses made by the keys bar and the phone keyboard ---

const MOD_KEYS = [
  [META, 'MetaLeft', 'Meta'],
  [CTRL, 'ControlLeft', 'Control'],
  [ALT, 'AltLeft', 'Alt'],
  [SHIFT, 'ShiftLeft', 'Shift'],
];

// A whole key press with modifiers held around it: modifiers down, key down, key up, modifiers up.
export function pressMessages(code, key, m = 0) {
  const out = [];
  let held = 0;
  for (const [bit, c, k] of MOD_KEYS) {
    if (!(m & bit)) continue;
    held |= bit;
    out.push({ t: 'k', c, k, d: true, m: held });
  }
  out.push({ t: 'k', c: code, k: key, d: true, m });
  out.push({ t: 'k', c: code, k: key, d: false, m });
  for (const [bit, c, k] of [...MOD_KEYS].reverse()) {
    if (!(m & bit)) continue;
    held &= ~bit;
    out.push({ t: 'k', c, k, d: false, m: held });
  }
  return out;
}

// The keys bar's special keys and shortcuts (always Mac keys: ⌘ is ⌘ whatever keyboard the viewer has).
export const SHORTCUTS = {
  esc: { code: 'Escape', key: 'Escape', m: 0 },
  tab: { code: 'Tab', key: 'Tab', m: 0 },
  left: { code: 'ArrowLeft', key: 'ArrowLeft', m: 0 },
  up: { code: 'ArrowUp', key: 'ArrowUp', m: 0 },
  down: { code: 'ArrowDown', key: 'ArrowDown', m: 0 },
  right: { code: 'ArrowRight', key: 'ArrowRight', m: 0 },
  delete: { code: 'Backspace', key: 'Backspace', m: 0 },
  enter: { code: 'Enter', key: 'Enter', m: 0 },
  cmdTab: { code: 'Tab', key: 'Tab', m: META },
  missionControl: { code: 'ArrowUp', key: 'ArrowUp', m: CTRL },
  spotlight: { code: 'Space', key: ' ', m: META },
  cmdQ: { code: 'KeyQ', key: 'q', m: META },
  cmdW: { code: 'KeyW', key: 'w', m: META },
};

// US-layout position of a typed character, for shortcuts made with the sticky modifiers (⌘ then "c" on a phone
// keyboard must press the C key, not type the letter). Returns {code, key, shift} or null.
const PUNCT = {
  ' ': ['Space', false], '-': ['Minus', false], '_': ['Minus', true], '=': ['Equal', false], '+': ['Equal', true],
  '[': ['BracketLeft', false], '{': ['BracketLeft', true], ']': ['BracketRight', false], '}': ['BracketRight', true],
  '\\': ['Backslash', false], '|': ['Backslash', true], ';': ['Semicolon', false], ':': ['Semicolon', true],
  "'": ['Quote', false], '"': ['Quote', true], ',': ['Comma', false], '<': ['Comma', true], '.': ['Period', false],
  '>': ['Period', true], '/': ['Slash', false], '?': ['Slash', true], '`': ['Backquote', false], '~': ['Backquote', true],
  '\n': ['Enter', false], '\t': ['Tab', false],
};
const SHIFTED_DIGITS = ')!@#$%^&*(';

export function charToKey(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return null;
  if (ch >= 'a' && ch <= 'z') return { code: 'Key' + ch.toUpperCase(), key: ch, shift: false };
  if (ch >= 'A' && ch <= 'Z') return { code: 'Key' + ch, key: ch, shift: true };
  if (ch >= '0' && ch <= '9') return { code: 'Digit' + ch, key: ch, shift: false };
  const d = SHIFTED_DIGITS.indexOf(ch);
  if (d >= 0) return { code: 'Digit' + d, key: ch, shift: true };
  const p = PUNCT[ch];
  if (!p) return null;
  const key = ch === '\n' ? 'Enter' : ch === '\t' ? 'Tab' : ch;
  return { code: p[0], key, shift: p[1] };
}

// Typed text is sent in pieces of at most 256 characters (the protocol's limit), never splitting an emoji in two.
export function textMessages(s, max = 256) {
  const out = [];
  let cur = '';
  for (const ch of s) {
    if (cur.length + ch.length > max) { out.push({ t: 'txt', s: cur }); cur = ''; }
    cur += ch;
  }
  if (cur) out.push({ t: 'txt', s: cur });
  return out;
}

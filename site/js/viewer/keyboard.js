// Keys and typing → the Mac. Three sources:
//   - a real keyboard while the Mac's picture has focus (keydown/keyup → {t:"k"});
//   - a phone or tablet keyboard, which types into an invisible text box (→ {t:"txt"}, plus key presses for
//     Backspace, Enter, Tab and arrows);
//   - the keys bar: sticky ⌘ ⌥ ⌃ ⇧, Esc, Tab, arrows and a few Mac shortcuts.
// Our own controls (the toolbar, its menus) keep their keys.
import { keyMessage, HeldKeys, pressMessages, SHORTCUTS, charToKey, textMessages, SHIFT } from './keys.js';

const OWN_KEYS = new Set(['Backspace', 'Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']);

// The text box always holds one invisible character: Android keyboards don't report Backspace in an empty box.
const SENTINEL = ' ';

export class KeyboardInput {
  constructor({ surface, softkbd, keysBar, session, swapCtrlCmd, enabled = () => true, onActivity = () => {} }) {
    Object.assign(this, { surface, softkbd, keysBar, session, swapCtrlCmd, enabled, onActivity });
    this.held = new HeldKeys();
    this.sticky = 0;       // modifier bits latched on the keys bar
    this.composing = false;
    this.listeners = [];
  }

  attach() {
    const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); this.listeners.push([el, type, fn, opts]); };
    // Capture phase on window, so the picture gets keys before anything else can act on them.
    on(window, 'keydown', e => this._key(e), true);
    on(window, 'keyup', e => this._key(e), true);
    on(window, 'blur', () => this.releaseAll());
    on(document, 'visibilitychange', () => { if (document.hidden) this.releaseAll(); });

    const t = this.softkbd;
    on(t, 'beforeinput', e => this._beforeInput(e));
    on(t, 'input', () => this._afterInput());
    on(t, 'compositionstart', () => { this.composing = true; });
    on(t, 'compositionend', e => {
      this.composing = false;
      if (e.data) this._text(e.data);
      this._resetBox();
    });
    on(t, 'focus', () => this._resetBox());

    // Keys bar buttons must not take focus away from the phone keyboard's text box (that would close the keyboard).
    on(this.keysBar, 'pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); });
    on(this.keysBar, 'click', e => this._keysBarClick(e));
  }

  detach() {
    for (const [el, type, fn, opts] of this.listeners) el.removeEventListener(type, fn, opts);
    this.listeners = [];
  }

  // Focus the invisible text box, which brings up a phone's keyboard. Must be called from a tap.
  showSoftKeyboard() {
    this._resetBox();
    this.softkbd.focus({ preventScroll: true });
  }

  _resetBox() {
    const t = this.softkbd;
    t.value = SENTINEL;
    try { t.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch {}
  }

  hideSoftKeyboard() { this.softkbd.blur(); }

  get softKeyboardOpen() { return document.activeElement === this.softkbd; }

  // Lets go of every key and button on the Mac (the viewer lost focus, so it would never see them come back up).
  releaseAll() {
    if (this.held.size || this.sticky) this.session.sendInput({ t: 'rel' });
    this.held.clear();
    this._setSticky(0);
  }

  // --- real keyboard ---

  _key(e) {
    if (!this.enabled()) return;
    const target = e.target;
    const inSoft = target === this.softkbd;
    if (!inSoft && target !== this.surface && target !== document.body && target !== document.documentElement) return;
    if (inSoft && (e.isComposing || this.composing || e.keyCode === 229)) return; // the phone keyboard's own business
    // In the text box, letters from a phone keyboard come through as text (beforeinput); a physical keyboard
    // attached to the tablet reports real key codes, so those, and the special keys, go as keys.
    if (inSoft && !e.code && !OWN_KEYS.has(e.key)) return;
    const msg = keyMessage(e, { swapCtrlCmd: this.swapCtrlCmd() });
    if (!msg) return;
    e.preventDefault();
    e.stopPropagation();
    this.onActivity(e);
    if (this.sticky && msg.d && !isModifier(msg.c)) {
      for (const m of pressMessages(msg.c, msg.k, msg.m | this.sticky)) this.session.sendInput(m);
      this._setSticky(0);
      return;
    }
    if (this.sticky && !msg.d && !isModifier(msg.c)) return; // its press already went out with the sticky keys
    for (const m of this.held.handle(msg)) this.session.sendInput(m);
  }

  // --- phone keyboard ---

  _beforeInput(e) {
    if (!this.enabled()) return;
    const type = e.inputType;
    if (type === 'insertCompositionText') return; // can't be stopped; compositionend has the result
    if (type === 'insertText' || type === 'insertReplacementText' || type === 'insertFromPaste') {
      const s = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
      e.preventDefault();
      if (s) this._text(s);
    } else if (type === 'insertLineBreak' || type === 'insertParagraph') {
      e.preventDefault();
      this._press(SHORTCUTS.enter);
    } else if (type === 'deleteContentBackward' || type === 'deleteWordBackward') {
      e.preventDefault();
      this._press(SHORTCUTS.delete);
    } else if (type === 'deleteContentForward') {
      e.preventDefault();
      this._press({ code: 'Delete', key: 'Delete', m: 0 });
    }
  }

  // Browsers that couldn't cancel the input (some Android keyboards): whatever landed in the box is the text.
  _afterInput() {
    const v = this.softkbd.value;
    if (this.composing || v === SENTINEL) return;
    if (v.length < SENTINEL.length) this._press(SHORTCUTS.delete);
    else this._text(v.startsWith(SENTINEL) ? v.slice(SENTINEL.length) : v);
    this._resetBox();
  }

  _text(s) {
    this.onActivity();
    if (this.sticky) {
      // ⌘ then "c" means the shortcut ⌘C, not the letter c.
      for (const ch of s) {
        const k = charToKey(ch);
        if (k) for (const m of pressMessages(k.code, k.key, this.sticky | (k.shift ? SHIFT : 0))) this.session.sendInput(m);
      }
      this._setSticky(0);
      return;
    }
    for (const m of textMessages(s)) this.session.sendInput(m);
  }

  // --- keys bar ---

  _keysBarClick(e) {
    const b = e.target.closest('button');
    if (!b || !this.enabled()) return;
    this.onActivity(e);
    if (b.dataset.mod) {
      this._setSticky(this.sticky ^ Number(b.dataset.mod));
      return;
    }
    const s = SHORTCUTS[b.dataset.key];
    if (s) this._press(s);
  }

  _press(s) {
    for (const m of pressMessages(s.code, s.key, s.m | this.sticky)) this.session.sendInput(m);
    this._setSticky(0);
  }

  _setSticky(bits) {
    this.sticky = bits;
    for (const b of this.keysBar.querySelectorAll('[data-mod]')) {
      b.setAttribute('aria-pressed', String(!!(bits & Number(b.dataset.mod))));
    }
  }
}

const isModifier = code => /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code) || code === 'CapsLock';

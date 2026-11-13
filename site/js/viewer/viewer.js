// The signed-in screen: the Mac's picture and sound filling the window, an auto-hiding toolbar, status notes, the
// keys bar and connection details. Input goes through viewer/pointer.js and viewer/keyboard.js.
//
// `session` is a ui/connection.js Connection (or the demo's stand-in, ui/demo.js) with send(), sendInput(),
// sendPointer(), getStats(), stream and the onstream / onmessage / onlink hooks.
import { PointerInput } from './pointer.js';
import { KeyboardInput } from './keyboard.js';
import { Banners } from './banners.js';
import { readStats, summarize, linkQuality, QUALITY_WORDS, statsLines } from './stats.js';
import { IDENTITY, isZoomed, viewTransform, clampView } from './coords.js';
import { errorMessage } from '../ui/messages.js';
import { fillIcons, setIcon } from '../ui/icons.js';
import { QUALITY } from '../shared/proto.js';
import { pressMessages, SHIFT, META } from './keys.js';
import {
  GROUPS, CATALOG, DEFAULT_BAR, FUNCTION_KEYS, CUSTOM_KEYS, SWIPE_ACTIONS, makeCustom, cleanCustom, cleanBar, findShortcut, toggleOnBar,
} from './shortcuts.js';

const HIDE_AFTER_MS = 3500;  // the toolbar tucks itself away after this long without being used
const SHOW_ZONE_PX = 56;     // moving the mouse this close to the top brings it back
const SIDE_ZONE_PX = 16;     // ...or this close to the bottom or a side, when the bar lives there
const EDGES = ['top', 'bottom', 'left', 'right'];
const DOUBLE_ESC_MS = 600;   // Esc twice within this brings back a hidden pointer
const PING_MS = 2000;
const MAX_CLIP = 30000; // clipboard text, either way (the Mac has the same limit)
const MAX_CLIP_IMAGE = 20 * 1024 * 1024; // clipboard pictures, either way (the Mac has the same limit)
const CLIP_PART = 48 * 1024;             // base64 characters per piece of a picture
const CLIP_BACKLOG = 2 * 1024 * 1024;    // pieces wait while this much is still queued on the connection
const PASTE_WAIT_MS = 400;               // after ⌘V, how long the browser's paste event gets before the Mac pastes its own

export class Viewer {
  constructor({ root, session, hi, ready, prefs, env, apple, touchFirst, log = () => {}, onLeave, onReconnect, onHome }) {
    Object.assign(this, { root, session, hi, ready, prefs, env, apple, touchFirst, log, onLeave, onReconnect, onHome });
    this.$ = id => document.getElementById(id);
    this.view = IDENTITY;
    this.timers = [];
    this.listeners = [];
    this.pingN = 0;
    this.pingMs = null;
    this.lastSnap = null;
    this.summary = null;
    this.status = {};
    this.over = false;
    this.guest = ready.guest === true;   // watching through a guest link: never any control
    this.inputAllowed = !this.guest && ready.input !== false;
    this.display = { ...(ready.display || {}) };
    this.hideTimer = null;
  }

  mount() {
    const { root, session } = this;
    root.hidden = false;
    root.classList.toggle('touch', !!this.touchFirst);
    document.body.classList.add('viewing');
    fillIcons(root);
    this.video = this.$('video');
    this.surface = this.$('surface');
    this.zoomEl = this.$('zoom');
    this.banners = new Banners(this.$('banners'));
    this.banners.clear();
    this.$('ended').hidden = true;
    this.$('stats').hidden = !this.prefs.get('stats');
    this.$('tbStats').setAttribute('aria-pressed', String(!this.$('stats').hidden));

    const attach = stream => {
      if (this.video.srcObject !== stream) this.video.srcObject = stream;
      this._play();
    };
    if (session.stream) attach(session.stream);
    session.onstream = attach;
    session.onmessage = m => this._message(m);
    session.onlink = state => {
      if (state === 'disconnected') {
        this.banners.show('link', { kind: 'warn', icon: 'refresh', title: 'Reconnecting…', body: 'The connection to your Mac dropped for a moment.' });
      } else {
        this.banners.hide('link');
      }
    };

    this._wireToolbar();
    const enabled = () => this.inputAllowed && !this.over;
    const activity = e => this._activity(e);
    this.pointer = new PointerInput({
      surface: this.surface, video: this.video, session,
      view: { get: () => this.view, set: v => this.setView(v) },
      size: () => [this.display.width || 0, this.display.height || 0],
      enabled, onActivity: activity, touchpad: () => this.touchFirst && !!this.prefs.get('touchpad'),
      onSwipe: dir => this._swipe(dir),
      swipesOn: () => this.inputAllowed && this.prefs.get('swipe') in SWIPE_ACTIONS && this.prefs.get('swipe') !== 'off',
    });
    this.keys = new KeyboardInput({
      surface: this.surface, softkbd: this.$('softkbd'), keysBar: this.$('keysBar'), session,
      swapCtrlCmd: () => !this.apple && this.prefs.get('swapCtrlCmd'), enabled, onActivity: activity,
      shortcut: id => findShortcut(id, this.customKeys),
      onPasteKey: () => this._pasteKey(),
    });
    // ⌘V / Ctrl+V on the picture: this device's clipboard, text or picture, is pasted on the Mac.
    this._on(window, 'paste', e => this._onPaste(e), true);
    // A copy from the Mac that couldn't be written here (this page didn't have focus) is written once it does.
    this._on(window, 'focus', () => this._retryMirror());
    this._on(window, 'pointerdown', () => this._retryMirror(), true);
    // Our own shortcut first, before the keys go to the Mac: Ctrl+Alt+Shift+T reaches the toolbar from the keyboard.
    this._on(window, 'keydown', e => this._ownShortcut(e), true);
    this.pointer.attach();
    this.keys.attach();
    this._wireKeyboardButton();
    this._wireKeysBar();
    this._wirePlacement();

    this._applyStatus({ locked: this.ready.locked, input: this.ready.input });
    const q = this.prefs.get('quality');
    this.$('tbQuality').value = q in QUALITY && !this.guest ? q : this.ready.quality;
    if (!this.guest && q in QUALITY && q !== this.ready.quality) session.send({ t: 'quality', preset: q });

    this._every(PING_MS, () => this._ping());
    this._every(1000, () => this._stats());
    this._ping();
    // Keep this device's screen on while the Mac is on it (phones dim and lock after a minute or so).
    this._keepAwake();
    this._on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') this._keepAwake(); });
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const fit = () => {
        // iPhones don't shrink the page for the on-screen keyboard; lift the keys bar above it ourselves.
        const below = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
        root.style.setProperty('--kb-inset', `${Math.round(below)}px`);
      };
      this._on(vv, 'resize', fit);
      this._on(vv, 'scroll', fit);
      fit();
    }
    this._on(window, 'resize', () => { this.setView(this.view); this._reportView(); });
    this._on(this.video, 'resize', () => this._reportView()); // the picture's own size or shape changed
    this._reportView();
    this._on(document, 'fullscreenchange', () => this._fullscreenChanged());
    this._on(document, 'webkitfullscreenchange', () => this._fullscreenChanged());
    this.surface.focus({ preventScroll: true });
    this._showToolbar();
  }

  // The session ended (the Mac said bye, the network went): freeze the picture and say what happened.
  ended(m, { canReconnect = true } = {}) {
    this.gone = true;
    if (this.over) return;
    this._releaseCmd();
    this.over = true;
    this._micOff();
    this._letSleep();
    if (document.pointerLockElement === this.surface) document.exitPointerLock();
    this.keys?.releaseAll();
    this._clearTimers();
    this.$('endedTitle').textContent = m.title;
    this.$('endedBody').textContent = m.body;
    const again = this.$('btnReconnect');
    again.hidden = !canReconnect;
    again.onclick = () => this.onReconnect();
    this.$('btnEndHome').onclick = () => this.onHome();
    this.$('ended').hidden = false;
    this.$('soundPrompt').hidden = true;
    this.$('clipSheet').hidden = true;
    this._inviteKeyboard(null);
    this.$('endedTitle').focus();
  }

  destroy() {
    this.gone = true;
    this._letSleep();
    this._releaseCmd();
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.placeFrame);
    if (document.pointerLockElement === this.surface) document.exitPointerLock();
    clearTimeout(this.captureNoteTimer);
    clearTimeout(this.inviteTimer);
    this.pointer?.detach();
    this.keys?.detach();
    for (const [el, type, fn, opts] of this.listeners) el.removeEventListener(type, fn, opts);
    this.listeners = [];
    this._clearTimers();
    clearTimeout(this.hideTimer);
    clearTimeout(this.viewTimer);
    this._micOff();
    if (this.session) { this.session.onmessage = this.session.onstream = this.session.onlink = this.session.onmicended = () => {}; }
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.setView(IDENTITY);
    this.banners?.clear();
    for (const id of ['ended', 'moreMenu', 'keysBar', 'keysEditor', 'soundPrompt', 'clipSheet']) this.$(id).hidden = true;
    clearTimeout(this.clipNoteTimer);
    this.clipWaiter = null;
    this.$('tbKeys').setAttribute('aria-pressed', 'false');
    this._inviteKeyboard(null);
    // The browser says the mouse is let go only after these listeners are gone: don't leave the pointer hidden.
    this.root.classList.remove('tb-on', 'zoomed', 'captured', 'touchpad', 'tb-pinned', 'tb-vertical', 'nocursor', ...EDGES.map(e => `tb-${e}`));
    this.root.hidden = true;
    document.body.classList.remove('viewing');
    navigator.keyboard?.unlock?.();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }

  // Local zoom: a CSS transform on the picture's wrapper. Nothing changes on the Mac.
  setView(v) {
    const box = this.surface.getBoundingClientRect();
    this.view = clampView(v, box);
    this.zoomEl.style.transform = viewTransform(this.view);
    const zoomed = isZoomed(this.view);
    if (this.pointer) this._reportView();
    this.root.classList.toggle('zoomed', zoomed);
    this.$('optZoom').disabled = !zoomed;
  }

  // --- messages from the Mac ---

  _message(m) {
    if (m.t === 'pong') {
      if (typeof m.ts === 'number') this.pingMs = Math.max(0, performance.now() - m.ts);
    } else if (m.t === 'status') {
      this._applyStatus(m);
    } else if (m.t === 'clip-part') {
      this._clipPartIn(m);
    } else if (m.t === 'clip') {
      if (m.auto) this._mirrorClip(m);
      else {
        this.clipWaiter?.(m);
        this.clipWaiter = null;
      }
    } else if (m.t === 'clip-set') {
      this._clipSetDone(m.ok === true);
    } else if (m.t === 'textfocus') {
      this._textFocus(m.editable === true, m.secure === true);
    } else if (m.t === 'windows') {
      this._setWindows(Array.isArray(m.list) ? m.list : []);
    } else if (m.t === 'mic') {
      // The Mac couldn't play the microphone (its sound output went away), or stopped it.
      if (m.on === false && this.micOn) {
        this._micOff();
        this.banners.show('mic', { kind: 'warn', icon: 'warn', title: "Your Mac couldn't play your microphone.",
          body: 'Check the sound output chosen in Perch\'s Setup on the Mac.', dismissible: true });
      }
    } else if (m.t === 'fit') {
      if (m.ok === false) {
        this.banners.show('fit', { kind: 'warn', icon: 'warn', title: "That window can't be reshaped.",
          body: 'Some apps fix the size of their windows.', dismissible: true });
      } else {
        this.banners.hide('fit');
      }
    } else if (m.t === 'error') {
      const e = errorMessage(m.code, m.message);
      this.banners.show('error', { kind: 'bad', icon: 'warn', title: e.title + '.', body: e.body });
    }
  }

  _applyStatus(st) {
    Object.assign(this.status, st);
    if ('locked' in st) {
      if (st.locked) {
        this.banners.show('locked', { kind: 'info', icon: 'lock', title: 'Your Mac is locked.',
          body: "You can try typing its password here; if that doesn't work, unlock it at the Mac." });
        if (this.touchFirst && this.inputAllowed !== false && document.activeElement !== this.$('softkbd')) {
          this._inviteKeyboard('Tap to type the password', { stay: true });
        }
      } else {
        this.banners.hide('locked');
        if (this.wasLocked) this._inviteKeyboard(null);
      }
      this.wasLocked = !!st.locked;
    }
    if ('input' in st) {
      this.inputAllowed = !this.guest && st.input !== false;
      this.root.classList.toggle('view-only', !this.inputAllowed);
      this._syncKeyboardButton();
      if (this.guest) {
        if (!this.guestNoted) {
          this.guestNoted = true;
          this.banners.show('guest', { kind: 'info', icon: 'eye', title: "You're watching as a guest.",
            body: "You can see and hear this Mac, but you can't control it.", dismissible: true });
        }
      } else if (!this.inputAllowed) {
        this.banners.show('viewonly', { kind: 'warn', icon: 'eye', title: 'View only.',
          body: "Your Mac hasn't let Perch control it yet. On the Mac, open System Settings › Privacy & Security › " +
            'Accessibility and turn on Perch.' });
      } else {
        this.banners.hide('viewonly');
      }
    }
    if ('link' in st) {
      if (st.link === 'slow') {
        const smooth = this.$('tbQuality').value === 'smooth';
        this.banners.show('slow', { kind: 'warn', icon: 'warn', title: 'The connection is slow.',
          body: smooth ? 'The picture may lag or look blurry.' : 'The picture may lag. Smooth quality needs less data.',
          action: smooth ? undefined : { label: 'Use Smooth', onClick: () => this._setQuality('smooth') },
          dismissible: true });
      } else {
        this.banners.hide('slow');
      }
    }
    if (st.width > 0 && st.height > 0) { this.display.width = st.width; this.display.height = st.height; }
    if (Array.isArray(st.displays)) this._setDisplays(st.displays, st.display);
    // Which window is being shown, if any. Just after choosing one here the Mac's older notes still say otherwise.
    if ('window' in st && performance.now() >= (this.windowChosenAt ?? -Infinity) + 1500) this._showWindow(st.window ?? null);
  }

  // --- clipboard text ---

  // Paste this device's clipboard on the Mac: straight away where the browser lets the page read it, otherwise
  // through a box to paste into (iPhones without a prompt, Firefox, a refusal).
  async _pasteToMac() {
    this._toggleMenu(false);
    // Pictures too, where the browser lets the page read them.
    if (this.clipImg && navigator.clipboard?.read) {
      try {
        let file = null, t = '';
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find(x => x.startsWith('image/'));
          if (type && !file) file = await item.getType(type);
          if (!t && item.types.includes('text/plain')) t = await (await item.getType('text/plain')).text();
        }
        if (file || t) return this._pasteHere(t, file);
      } catch { /* refused or not offered: text only, below */ }
    }
    let text = null;
    try { text = await navigator.clipboard.readText(); } catch { text = null; }
    if (typeof text === 'string' && text.length > 0 && text.length <= MAX_CLIP) return this._sendClip(text, true);
    this._openClip('send', typeof text === 'string' && text.length > MAX_CLIP ? 'That text is too long to send in one go.' : '');
  }

  _sendClip(text, paste) {
    if (!text) { this._clipStatus('There\u2019s no text to send.'); return; }
    if (text.length > MAX_CLIP) { this._clipStatus('That text is too long to send in one go.'); return; }
    this.clipPasting = paste;
    this.session.send({ t: 'clip-set', text, paste });
  }

  _clipSetDone(ok) {
    if (this.clipPasting === 'key') {
      // From ⌘V or Paste on the Mac: now the Mac pastes it.
      this.clipPasting = null;
      if (ok) {
        this.keys.pasteKey();
        if (this.clipSentImage) this._clipNote('Pasted on your Mac.', 'paste');
      } else {
        this._clipNote('Your Mac didn\u2019t take that.', 'paste');
      }
      return;
    }
    if (!ok) {
      if (this.$('clipSheet').hidden) this._openClip('send', '');
      this._clipStatus('Your Mac didn\u2019t take that text.');
      return;
    }
    this._closeClip();
    this.banners.show('clip', { kind: 'info', icon: this.clipPasting ? 'paste' : 'copy',
      title: this.clipPasting ? 'Pasted on your Mac.' : 'On your Mac\u2019s clipboard.', dismissible: true });
    clearTimeout(this.clipNoteTimer);
    this.clipNoteTimer = setTimeout(() => this.banners.hide('clip'), 3000);
  }

  // --- the clipboard without the box: ⌘V pastes this device's clipboard, and copies on the Mac come here ---

  // ⌘V on the picture. True: wait for the browser's paste event (and if none comes, the Mac pastes its own).
  _pasteKey() {
    if (!this.clipImg || this.guest) return false;
    clearTimeout(this.pasteTimer);
    this.pasteWaiting = true;
    this.pasteTimer = setTimeout(() => {
      if (!this.pasteWaiting) return;
      this.pasteWaiting = false;
      this.keys.pasteKey();
    }, PASTE_WAIT_MS);
    return true;
  }

  _onPaste(e) {
    if (!this.pasteWaiting) return; // a paste into one of our own text boxes stays there
    this.pasteWaiting = false;
    clearTimeout(this.pasteTimer);
    e.preventDefault();
    e.stopPropagation();
    const dt = e.clipboardData;
    let file = null;
    for (const item of dt?.items ?? []) {
      if (item.kind === 'file' && item.type.startsWith('image/')) { file = item.getAsFile(); break; }
    }
    this._pasteHere(dt?.getData('text/plain') ?? '', file);
  }

  // Puts text and/or a picture on the Mac's clipboard, then presses ⌘V there. Nothing here: the Mac pastes its own.
  async _pasteHere(text, file) {
    if (text && text.length > MAX_CLIP) text = '';
    if (file && file.size > MAX_CLIP_IMAGE) {
      this._clipNote('That picture is too big to send (20 MB at most).', 'paste');
      file = null;
      if (!text) return;
    }
    if (!text && !file) { this.keys.pasteKey(); return; }
    const msg = { t: 'clip-set', paste: false };
    if (text) msg.text = text;
    if (file) {
      if (file.size > 1024 * 1024) this._clipNote('Sending the picture\u2026', 'paste', 0);
      let b64;
      try { b64 = await blobToBase64(file); } catch { this._clipNote('Couldn\u2019t read that picture.', 'paste'); return; }
      const id = Math.random().toString(36).slice(2, 12);
      const n = Math.ceil(b64.length / CLIP_PART);
      for (let i = 0; i < n; i++) {
        while ((this.session.controlBacklog?.() ?? 0) > CLIP_BACKLOG) await new Promise(r => setTimeout(r, 30));
        if (this.gone) return;
        this.session.send({ t: 'clip-part', id, i, n, data: b64.slice(i * CLIP_PART, (i + 1) * CLIP_PART) });
      }
      msg.img = { id, mime: file.type || 'image/png' };
    }
    this.clipPasting = 'key';
    this.clipSentImage = !!file;
    this.session.send(msg);
  }

  _clipPartIn(m) {
    if (typeof m.id !== 'string' || !Number.isInteger(m.i) || !Number.isInteger(m.n) || typeof m.data !== 'string') return;
    if (m.i === 0) this.clipIn = { id: m.id, n: m.n, parts: [] };
    const c = this.clipIn;
    if (!c || c.id !== m.id || c.parts.length !== m.i) { this.clipIn = null; return; }
    c.parts.push(m.data);
  }

  // The picture a {t:'clip'} names, put back together, or null.
  _clipImageOf(m) {
    const c = this.clipIn;
    this.clipIn = null;
    if (!m.img || !c || c.id !== m.img.id || c.parts.length !== c.n) return null;
    try {
      const bin = atob(c.parts.join(''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: 'image/png' });
    } catch { return null; }
  }

  // Just copied on the Mac: onto this device's clipboard too.
  _mirrorClip(m) {
    const img = this._clipImageOf(m);
    const text = m.ok && typeof m.text === 'string' ? m.text : '';
    if (!img && !text) return;
    const write = async () => {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const items = {};
        if (img) items['image/png'] = img;
        if (text) items['text/plain'] = new Blob([text], { type: 'text/plain' });
        try { return await navigator.clipboard.write([new ClipboardItem(items)]); } catch (err) { if (!text || !img) throw err; }
      }
      if (!text) throw new Error('no picture clipboard here');
      await navigator.clipboard.writeText(text);
    };
    const note = img ? 'Picture copied from your Mac.' : 'Copied from your Mac.';
    this.pendingMirror = null;
    write().then(() => this._clipNote(note, 'copy', 1500), () => { this.pendingMirror = { write, note }; });
  }

  _retryMirror() {
    const p = this.pendingMirror;
    if (!p) return;
    this.pendingMirror = null;
    p.write().then(() => this._clipNote(p.note, 'copy', 1500), () => {});
  }

  _clipNote(title, icon, ms = 3000) {
    this.banners.show('clip', { kind: 'info', icon, title, dismissible: true });
    clearTimeout(this.clipNoteTimer);
    if (ms) this.clipNoteTimer = setTimeout(() => this.banners.hide('clip'), ms);
  }

  // Copy the Mac's clipboard to this device. Browsers only let a page write the clipboard during a click, and the
  // Mac's answer comes a moment later, so the write is started now with the text still on its way (ClipboardItem
  // takes a promise); where that isn't possible the text is shown, selected, to copy by hand.
  _copyFromMac() {
    this._toggleMenu(false);
    const answer = new Promise(resolve => {
      this.clipWaiter = resolve;
      setTimeout(() => resolve({ ok: false, timeout: true }), 5000);
    });
    this.session.send({ t: 'clip-get' });
    // An empty Mac clipboard leaves this device's clipboard as it is.
    const text = answer.then(m => (m.ok && typeof m.text === 'string' && m.text ? m.text : Promise.reject(new Error('no text'))));
    const done = n => {
      this.banners.show('clip', { kind: 'info', icon: 'copy', title: n ? 'Copied from your Mac.' : 'Your Mac\u2019s clipboard has no text.', dismissible: true });
      clearTimeout(this.clipNoteTimer);
      this.clipNoteTimer = setTimeout(() => this.banners.hide('clip'), 3000);
    };
    const byHand = async () => {
      let t = '';
      try { t = await text; } catch { /* none */ }
      if (!t) return done(0);
      this._openClip('show', '', t);
    };
    let writing;
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('no ClipboardItem');
      writing = navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(t => new Blob([t], { type: 'text/plain' })) })]);
    } catch {
      writing = text.then(t => navigator.clipboard.writeText(t));
    }
    // A browser that neither writes nor refuses within a few seconds gets the text shown instead.
    const stuck = new Promise((_, reject) => setTimeout(() => reject(new Error('stuck')), 6000));
    Promise.race([writing, stuck]).then(async () => done((await text).length), () => byHand());
  }

  // The box for clipboard text: 'send' (to the Mac) or 'show' (the Mac's text, to copy by hand).
  _openClip(mode, error, text = '') {
    const $ = this.$;
    const show = mode === 'show';
    $('clipTitle').textContent = show ? 'Your Mac\u2019s clipboard' : 'Send text to your Mac';
    $('clipHelp').textContent = show ? 'This browser can\u2019t copy it by itself. It\u2019s selected: copy it from here.'
      : 'Paste or type it here.';
    $('clipText').value = text;
    $('clipText').readOnly = show;
    $('clipGo').hidden = $('clipOnly').hidden = show;
    $('clipClose').textContent = show ? 'Done' : 'Cancel';
    this._clipStatus(error);
    $('clipSheet').hidden = false;
    $('clipText').focus({ preventScroll: true });
    if (show) $('clipText').select();
  }

  _clipStatus(text) {
    const el = this.$('clipStatus');
    el.textContent = text || '';
    el.hidden = !text;
  }

  _closeClip() {
    this.$('clipSheet').hidden = true;
    this.$('clipText').value = '';
    this.surface.focus({ preventScroll: true });
  }

  // --- the microphone: what you say here is played on the Mac ---

  async _toggleMic() {
    if (this.micOn) {
      this._micOff();
      this.session.send({ t: 'mic', on: false });
      return;
    }
    if (this.micBusy) return;
    this.micBusy = true;
    this._toggleMenu(false);
    try {
      await this.session.startMic();
    } catch (e) {
      const refused = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
      this.banners.show('mic', { kind: 'warn', icon: 'warn',
        title: refused ? "The microphone isn't allowed here." : "Couldn't start the microphone.",
        body: refused ? "Allow the microphone for this site in your browser's settings, then try again."
          : 'Check that this device has a microphone and nothing else is using it.', dismissible: true });
      return;
    } finally {
      this.micBusy = false;
    }
    if (this.over) { this.session.stopMic?.(); return; }
    this.micOn = true;
    this.session.send({ t: 'mic', on: true });
    this.$('optMic').setAttribute('aria-pressed', 'true');
    this.$('optMic').lastChild.textContent = 'Stop talking through your Mac';
    this.banners.show('mic', { kind: 'info', icon: 'mic', title: 'Your microphone is on.',
      body: 'Your Mac is playing what you say.', action: { label: 'Turn off', onClick: () => this._toggleMic() } });
  }

  // Off on this side (the Mac is told separately, when it doesn't already know).
  _micOff() {
    if (!this.micOn) return;
    this.micOn = false;
    this.session.stopMic?.();
    this.$('optMic').setAttribute('aria-pressed', 'false');
    this.$('optMic').lastChild.textContent = 'Talk through your Mac';
    this.banners.hide('mic');
  }

  // --- one window ---

  // The windows on the Mac right now, asked for each time the menu opens.
  _setWindows(list) {
    const sel = this.$('optWindow');
    const whole = document.createElement('option');
    whole.value = '';
    whole.textContent = 'The whole screen';
    sel.replaceChildren(whole, ...list.filter(w => Number.isInteger(w?.id)).map(w => {
      const o = document.createElement('option');
      o.value = String(w.id);
      const app = String(w.app ?? '').trim(), title = String(w.title ?? '').trim();
      o.textContent = (title && title !== app ? `${app || 'Window'}: ${title}` : app || 'Window').slice(0, 60);
      return o;
    }));
    // The one being shown may have gone from the list (it was closed); the Mac says so in its next note.
    sel.value = this.windowId != null && [...sel.options].some(o => o.value === String(this.windowId)) ? String(this.windowId) : '';
  }

  _showWindow(id) {
    if (id === (this.windowId ?? null)) return;
    this.windowId = id;
    const sel = this.$('optWindow');
    if (id != null && ![...sel.options].some(o => o.value === String(id))) {
      const o = document.createElement('option');
      o.value = String(id);
      o.textContent = 'One window';
      sel.append(o);
    }
    sel.value = id == null ? '' : String(id);
    this.$('optFit').hidden = id == null;
    this.setView(IDENTITY);
  }

  _chooseWindow(value) {
    const id = value === '' ? null : Number(value);
    if (id !== null && !Number.isInteger(id)) return;
    this.windowChosenAt = performance.now();
    this._showWindow(id);
    this.session.send({ t: 'window', id });
  }

  // Reshape the window on the Mac to this screen's shape, so it fills the screen here.
  _fitWindow() {
    const box = this.surface.getBoundingClientRect();
    if (this.windowId == null || !(box.width > 0 && box.height > 0)) return;
    this.session.send({ t: 'fit', w: Math.round(box.width), h: Math.round(box.height) });
    this._toggleMenu(false);
  }

  // --- regular checks ---

  _ping() {
    this.session.send({ t: 'ping', n: ++this.pingN, ts: Math.round(performance.now() * 10) / 10 });
  }

  async _stats() {
    let report;
    try { report = await this.session.getStats(); } catch { return; }
    const snap = readStats(report);
    if (snap.video) {
      this.summary = summarize(this.lastSnap, snap);
      this.lastSnap = snap;
    }
    const sum = this.summary || summarize(null, snap);
    const q = linkQuality({ rttMs: this.pingMs ?? sum.rttMs, lossPct: sum.lossPct, macSaysSlow: this.status.link === 'slow' });
    const dot = this.$('dot');
    dot.className = `dot ${q}`;
    dot.setAttribute('aria-label', QUALITY_WORDS[q]);
    dot.title = QUALITY_WORDS[q];
    const panel = this.$('stats');
    if (panel.hidden) return;
    const lines = statsLines(sum, { pingMs: this.pingMs, decoder: snap.video?.decoder });
    if (this.status.fps != null || this.status.kbps != null) {
      lines.push(['Mac sends', `${this.status.fps ?? '–'} fps, ${this.status.kbps ?? '–'} kbit/s`]);
    }
    const dl = document.createElement('dl');
    for (const [k, v] of lines) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    panel.replaceChildren(dl);
  }

  // --- sound ---

  async _play() {
    const v = this.video;
    const hasAudio = this.ready.audio !== false && (v.srcObject?.getAudioTracks?.().length ?? 0) > 0;
    v.muted = !hasAudio || this.prefs.get('muted');
    try { v.volume = this.prefs.get('volume'); } catch {}
    try {
      await v.play();
    } catch (e) {
      if (e.name !== 'NotAllowedError') return;
      // The browser wants a tap before it plays sound: play silently now, and offer the tap.
      v.muted = true;
      try { await v.play(); } catch {}
      if (hasAudio && !this.prefs.get('muted')) this.$('soundPrompt').hidden = false;
    }
    this._soundUi();
  }

  soundBlocked() {
    this.video.muted = true;
    this.$('soundPrompt').hidden = false;
    this._soundUi();
  }

  _soundUi() {
    const v = this.video;
    const has = this.ready.audio !== false;
    const b = this.$('tbSound');
    b.hidden = !has;
    this.$('tbVolumeWrap').hidden = !has || this.touchFirst;
    setIcon(b, v.muted ? 'muted' : 'sound');
    b.setAttribute('aria-label', v.muted ? 'Turn sound on' : 'Mute');
    b.title = v.muted ? 'Sound is off' : 'Sound is on';
    this.$('tbVolume').value = String(v.volume ?? 1);
  }

  _setMuted(muted) {
    const v = this.video;
    v.muted = muted;
    this.prefs.set('muted', muted);
    if (!muted) v.play().catch(() => {});
    this.$('soundPrompt').hidden = true;
    this._soundUi();
  }

  // --- toolbar ---

  _wireToolbar() {
    const $ = this.$;
    $('tbName').textContent = this.ready.name || this.hi.name || 'your Mac';
    const on = (id, type, fn) => this._on($(id), type, fn);

    on('tbQuality', 'change', e => this._setQuality(e.target.value));

    // A guest only watches: nothing here that would change the Mac or what it sends.
    for (const id of ['tbKeys', 'tbMore']) $(id).hidden = this.guest;
    $('tbQuality').closest('label').hidden = this.guest;
    // 60 frames a second, on Macs that offer it.
    const fast = $('tbQuality').querySelector('option[value="fast"]');
    fast.hidden = fast.disabled = !this.session.caps?.includes('fps60');

    const sel = $('tbDisplay');
    this._setDisplays(Array.isArray(this.ready.displays) ? this.ready.displays : [], this.display.id);
    on('tbDisplay', 'change', () => {
      const d = this.displays.find(x => String(x.id) === sel.value);
      if (!d) return;
      this.display = { id: d.id, width: d.width, height: d.height };
      this._showWindow(null); // a window chosen on the other display doesn't carry over
      this.session.send({ t: 'display', id: d.id });
      this.setView(IDENTITY);
    });

    // On a phone the toolbar can't hold everything, so the two pickers live in the More menu there.
    // So do they when the bar stands up on the left or right.
    const narrow = window.matchMedia('(max-width: 640px)');
    this._placePickers = () => {
      const pickers = [$('tbQuality').closest('label'), $('tbDisplayWrap')];
      const menu = (narrow.matches || this.root.classList.contains('tb-vertical')) && !this.guest;
      if (menu && pickers[0].parentElement !== $('moreMenu')) $('moreMenu').prepend(...pickers);
      else if (!menu && pickers[0].parentElement !== $('toolbar')) $('tbKeyboard').before(...pickers);
    };
    this._placePickers();
    this._on(narrow, 'change', () => this._placeToolbar());

    $('tbKeyboard').hidden = !this.touchFirst;
    // pointerdown keeps the phone keyboard's focus while the button is pressed, so the button can toggle it.
    on('tbKeyboard', 'pointerdown', e => e.preventDefault());
    on('tbKeyboard', 'click', () => {
      if (this.keys.softKeyboardOpen) this.keys.hideSoftKeyboard(); else this.keys.showSoftKeyboard();
    });
    on('tbKeys', 'click', () => {
      const bar = $('keysBar');
      bar.hidden = !bar.hidden;
      $('tbKeys').setAttribute('aria-pressed', String(!bar.hidden));
      if (bar.hidden) this._closeKeysEditor();
    });

    on('tbSound', 'click', () => this._setMuted(!this.video.muted));
    on('tbVolume', 'input', e => {
      const vol = Number(e.target.value);
      try { this.video.volume = vol; } catch {}
      this.prefs.set('volume', vol);
      if (vol > 0 && this.video.muted) this._setMuted(false);
    });
    on('soundPrompt', 'click', () => this._setMuted(false));

    const canFull = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    $('tbFull').hidden = !canFull;
    on('tbFull', 'click', () => this._toggleFullscreen());

    // Capture the mouse, as games do: this computer's pointer disappears and the mouse moves only the Mac's.
    const canCapture = !this.touchFirst && !this.guest && 'requestPointerLock' in this.surface;
    $('tbCapture').hidden = !canCapture;
    $('captureClickWrap').hidden = !canCapture;
    $('optCaptureClick').checked = !!this.prefs.get('captureOnClick');
    on('optCaptureClick', 'change', e => this.prefs.set('captureOnClick', e.target.checked));
    on('tbCapture', 'click', () => (this.pointer?.locked ? document.exitPointerLock() : this._capture()));
    this._on(this.surface, 'pointerdown', e => {
      if (canCapture && e.pointerType === 'mouse' && !this.pointer?.locked && this.prefs.get('captureOnClick') && this.inputAllowed) this._capture();
    });
    this._on(document, 'pointerlockchange', () => {
      const locked = document.pointerLockElement === this.surface;
      $('tbCapture').setAttribute('aria-pressed', String(locked));
      $('tbCapture').setAttribute('aria-label', locked ? 'Let go of the mouse' : 'Capture the mouse');
      this.root.classList.toggle('captured', locked);
      if (locked) {
        this._hideToolbar(true);
        this.banners.show('capture', { kind: 'info', icon: 'pointer', title: 'The mouse is captured.',
          body: 'It moves only your Mac\u2019s pointer. Press Esc to let go.', dismissible: true });
        clearTimeout(this.captureNoteTimer);
        this.captureNoteTimer = setTimeout(() => this.banners.hide('capture'), 4000);
      } else {
        this.banners.hide('capture');
      }
    });
    this._on(document, 'pointerlockerror', () => {
      this.banners.show('capture', { kind: 'warn', icon: 'warn', title: "This browser didn't let Perch capture the mouse.",
        body: 'Click the Mac\u2019s screen first, then try again.', dismissible: true });
    });

    on('tbStats', 'click', () => {
      const panel = $('stats');
      panel.hidden = !panel.hidden;
      this.prefs.set('stats', !panel.hidden);
      $('tbStats').setAttribute('aria-pressed', String(!panel.hidden));
      if (!panel.hidden) this._stats();
    });

    on('tbMore', 'click', () => this._toggleMenu());
    $('swapWrap').hidden = $('swapHelp').hidden = this.apple;
    $('optSwap').checked = !!this.prefs.get('swapCtrlCmd');
    on('optSwap', 'change', e => {
      this.keys.releaseAll();
      this.prefs.set('swapCtrlCmd', e.target.checked);
    });
    on('optZoom', 'click', () => { this.setView(IDENTITY); this._toggleMenu(false); });
    // Touchpad mode, on phones and tablets.
    $('touchpadWrap').hidden = $('touchpadHelp').hidden = !this.touchFirst || this.guest;
    $('optTouchpad').checked = !!this.prefs.get('touchpad');
    on('optTouchpad', 'change', e => {
      this.prefs.set('touchpad', e.target.checked);
      this.root.classList.toggle('touchpad', e.target.checked);
    });
    this.root.classList.toggle('touchpad', this.touchFirst && !!this.prefs.get('touchpad'));

    // Clipboard text both ways, on Macs that offer it.
    const canClip = !this.guest && !!this.session.caps?.includes('clipboard');
    $('optPaste').hidden = $('optCopy').hidden = !canClip;
    // Pictures, ⌘V without the box, and copies on the Mac coming here by themselves, on Macs that offer them.
    this.clipImg = canClip && !!this.session.caps?.includes('clipimg');
    $('clipSyncWrap').hidden = !this.clipImg;
    $('optClipSync').checked = !!this.prefs.get('clipSync');
    if (this.clipImg && this.prefs.get('clipSync')) this.session.send({ t: 'clip-sync', on: true });
    on('optClipSync', 'change', e => {
      this.prefs.set('clipSync', e.target.checked);
      this.session.send({ t: 'clip-sync', on: e.target.checked });
    });
    on('optPaste', 'click', () => this._pasteToMac());
    on('optCopy', 'click', () => this._copyFromMac());
    on('clipGo', 'click', () => this._sendClip($('clipText').value, true));
    on('clipOnly', 'click', () => this._sendClip($('clipText').value, false));
    on('clipClose', 'click', () => this._closeClip());
    this._on($('clipSheet'), 'keydown', e => { if (e.key === 'Escape') { e.preventDefault(); this._closeClip(); } });

    // Talking through the Mac, where the Mac, the browser and the connection all can.
    this.micOn = false;
    $('optMic').hidden = this.guest || !this.session.canMic;
    on('optMic', 'click', () => this._toggleMic());
    this.session.onmicended = () => {
      if (!this.micOn) return;
      this._micOff();
      this.session.send({ t: 'mic', on: false });
    };
    // One window at a time, on Macs that offer it.
    const canWindow = !this.guest && !!this.session.caps?.includes('window');
    $('windowWrap').hidden = !canWindow;
    $('optFit').hidden = true;
    this.windowId = null;
    this._setWindows([]);
    on('optWindow', 'change', e => this._chooseWindow(e.target.value));
    on('optFit', 'click', () => this._fitWindow());
    on('optKeyframe', 'click', () => { this.session.send({ t: 'keyframe' }); this._toggleMenu(false); });
    on('tbBye', 'click', () => this.onLeave());

    on('handle', 'click', () => this._showToolbar());
    const tb = $('toolbar');
    this._on(tb, 'focusin', () => this._showToolbar());
    this._on(tb, 'pointerenter', () => this._showToolbar());
    this._on(tb, 'pointerleave', () => this._showToolbar());
    this._on(tb, 'keydown', e => this._toolbarKey(e));
    this._on($('moreMenu'), 'keydown', e => this._toolbarKey(e));
    // On the whole viewer, not just the picture: at the top in the middle the mouse is over the handle instead.
    this._on(this.root, 'pointermove', e => {
      if (e.pointerType === 'touch' || this.pointer?.locked || !this._autoHide()) return;
      const box = this.root.getBoundingClientRect();
      const near = { top: e.clientY - box.top < SHOW_ZONE_PX, bottom: box.bottom - e.clientY < SIDE_ZONE_PX,
        left: e.clientX - box.left < SIDE_ZONE_PX, right: box.right - e.clientX < SIDE_ZONE_PX };
      if (near[this.prefs.get('tbEdge')]) this._showToolbar();
    });
    this._on(this.surface, 'pointerdown', () => { this._toggleMenu(false); this._closeKeysEditor(); });
  }

  // The display picker. Called again when the Mac says its displays changed (one was unplugged or plugged in).
  _setDisplays(displays, shownId) {
    this.displays = displays;
    const sel = this.$('tbDisplay');
    sel.replaceChildren(...displays.map((d, i) => {
      const o = document.createElement('option');
      o.value = String(d.id);
      o.textContent = d.name || `Display ${i + 1}`;
      return o;
    }));
    const shown = displays.find(d => d.id === shownId) ?? displays[0];
    if (shown) {
      sel.value = String(shown.id);
      if (this.display.id !== shown.id) {
        this.display = { id: shown.id, width: shown.width, height: shown.height };
        this.setView(IDENTITY);
      }
    }
    // A guest can't switch displays (the Mac ignores it), so they aren't offered the picker.
    this.$('tbDisplayWrap').hidden = displays.length < 2 || !!this.guest;
  }

  // Tells the Mac how big its picture is on this screen, in real pixels, so it doesn't send more than can be shown
  // (a phone needs far fewer than a desktop monitor, and fewer pixels means a smoother picture on the same link).
  // Zooming in asks for up to twice as many. Sent a moment after things settle, and only when it changed.
  _reportView() {
    if (this.guest || !this.session.caps?.includes('view')) return;
    clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => {
      if (this.over) return;
      const box = this.surface.getBoundingClientRect();
      const [vw, vh] = this.pointer.pictureSize();
      if (!(box.width > 0 && box.height > 0 && vw > 0 && vh > 0)) return;
      const shown = Math.min(box.width / vw, box.height / vh); // CSS pixels per picture pixel
      const zoom = Math.min(2, Math.max(1, this.view.scale ?? 1));
      const edge = Math.round(Math.max(vw, vh) * shown * (window.devicePixelRatio || 1) * zoom);
      if (this.lastViewEdge && Math.abs(edge - this.lastViewEdge) < this.lastViewEdge * 0.08) return;
      this.lastViewEdge = edge;
      this.session.send({ t: 'view', edge });
    }, 600);
  }

  _setQuality(preset) {
    if (!(preset in QUALITY)) return;
    this.$('tbQuality').value = preset;
    this.prefs.set('quality', preset);
    this.session.send({ t: 'quality', preset });
    if (this.status.link === 'slow') this._applyStatus({ link: 'slow' });
  }

  _toggleMenu(open) {
    const menu = this.$('moreMenu');
    const show = open ?? menu.hidden;
    menu.hidden = !show;
    this.$('tbMore').setAttribute('aria-expanded', String(show));
    if (show) {
      this._showToolbar();
      if (!this.$('windowWrap').hidden) this.session.send({ t: 'windows' });
    }
  }

  async _keepAwake() {
    if (this.over || !navigator.wakeLock || (this.wakeLock && !this.wakeLock.released)) return;
    try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed here; no matter */ }
    if (this.over) this._letSleep();
  }

  _letSleep() {
    const w = this.wakeLock;
    this.wakeLock = null;
    w?.release?.().catch?.(() => {});
  }

  async _capture() {
    if (this.over || !this.inputAllowed) return;
    this._toggleMenu(false);
    this.surface.focus({ preventScroll: true });
    // Raw mouse movement (no acceleration) where the browser offers it, as games want.
    try {
      await this.surface.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try { await this.surface.requestPointerLock(); } catch { /* pointerlockerror says so */ }
    }
  }

  // --- where the toolbar sits: any edge, anywhere along it ---

  _wirePlacement() {
    const $ = this.$, prefs = this.prefs;
    const edge = $('optEdge'), auto = $('optAutoHide');
    edge.value = prefs.get('tbEdge');
    auto.checked = this._autoHide();
    this._on(edge, 'change', () => { prefs.set('tbEdge', edge.value); prefs.set('tbPos', 0.5); this._placeToolbar(); this._showToolbar(); });
    this._on(auto, 'change', () => { prefs.set('tbAutoHide', auto.checked); this._placeToolbar(); this._showToolbar(); });

    // Drag the grip: the bar jumps to whichever edge the pointer is nearest, at the pointer's place along it.
    const grip = $('tbGrip');
    let dragging = null;
    this._on(grip, 'pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = e.pointerId;
      try { grip.setPointerCapture(e.pointerId); } catch {}
      this.root.classList.add('tb-dragging');
    });
    this._on(window, 'pointermove', e => {
      if (e.pointerId !== dragging) return;
      const box = this.root.getBoundingClientRect();
      const x = e.clientX - box.left, y = e.clientY - box.top;
      const dist = { top: y, bottom: box.height - y, left: x, right: box.width - x };
      const near = EDGES.reduce((a, b) => (dist[b] < dist[a] ? b : a));
      prefs.values.tbEdge = near;
      prefs.values.tbPos = Math.min(1, Math.max(0, near === 'top' || near === 'bottom' ? x / box.width : y / box.height));
      this._placeToolbar();
    });
    const drop = e => {
      if (e.pointerId !== dragging) return;
      dragging = null;
      this.root.classList.remove('tb-dragging');
      prefs.set('tbEdge', prefs.get('tbEdge'));
      prefs.set('tbPos', Math.round(prefs.get('tbPos') * 1000) / 1000);
      $('optEdge').value = prefs.get('tbEdge');
      this._showToolbar();
    };
    this._on(window, 'pointerup', drop, true);
    this._on(window, 'pointercancel', drop, true);
    // From the keyboard: the arrow keys slide it along its edge.
    this._on(grip, 'keydown', e => {
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!step) return;
      e.preventDefault();
      prefs.set('tbPos', Math.min(1, Math.max(0, prefs.get('tbPos') + step * 0.05)));
      this._placeToolbar();
    });

    // The bar, the keys bar and the window changing size all move things about.
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(this.placeFrame);
        this.placeFrame = requestAnimationFrame(() => this._placeToolbar());
      });
      for (const id of ['toolbar', 'keysBar', 'viewer']) this.resizeObserver.observe($(id));
    }
    this._placeToolbar();
  }

  // Unless chosen otherwise, the bar stays put with a mouse and hides itself on touch screens (small, and a tap on
  // the handle is easy there).
  _autoHide() {
    const v = this.prefs.get('tbAutoHide');
    return typeof v === 'boolean' ? v : !!this.touchFirst;
  }

  _placeToolbar() {
    if (!this.root || this.root.hidden) return;
    const root = this.root, tb = this.$('toolbar'), handle = this.$('handle');
    const edge = this.prefs.get('tbEdge'), pos = this.prefs.get('tbPos');
    const pinned = !this._autoHide();
    const vertical = edge === 'left' || edge === 'right';
    for (const e of EDGES) root.classList.toggle(`tb-${e}`, e === edge);
    root.classList.toggle('tb-pinned', pinned);
    root.classList.toggle('tb-vertical', vertical);
    this._placePickers?.();
    tb.style.left = tb.style.top = '';  // measured where the edge's own rules put it
    const W = root.clientWidth, H = root.clientHeight, w = tb.offsetWidth, h = tb.offsetHeight;
    const clampPx = (v, max) => Math.round(Math.min(Math.max(0, max), Math.max(0, v)));
    if (vertical) {
      tb.style.left = '';
      tb.style.top = `${clampPx(pos * H - h / 2, H - h)}px`;
      handle.style.left = '';
      handle.style.top = `${Math.round(pos * 100)}%`;
    } else {
      tb.style.top = '';
      tb.style.left = `${clampPx(pos * W - w / 2, W - w)}px`;
      handle.style.top = '';
      handle.style.left = `${Math.round(pos * 100)}%`;
    }
    // A bar that stays put gets its own strip: the Mac's picture shrinks to fit beside it rather than under it.
    const size = vertical ? w : h;
    for (const e of EDGES) root.style.setProperty(`--tb-${e}`, `${pinned && e === edge ? size : 0}px`);
    // So does the keys bar, with a mouse (on a touch screen it comes and goes with the phone keyboard).
    const bar = this.$('keysBar');
    root.style.setProperty('--keys-h', `${!this.touchFirst && !bar.hidden ? bar.offsetHeight : 0}px`);
    const box = this.surface.getBoundingClientRect();
    const key = `${Math.round(box.width)}x${Math.round(box.height)}`;
    if (key !== this.surfaceKey) {
      this.surfaceKey = key;
      this.setView(this.view);
      this._reportView();
    }
  }

  // --- this computer's pointer, hidden so only the Mac's shows ---

  _setHideCursor(on, { note = true } = {}) {
    on = on && !this.touchFirst;
    this.prefs.set('hideCursor', on);
    this.$('optHideCursor').checked = on;
    this.root.classList.toggle('nocursor', on);
    if (!note) return;
    this.banners.show('cursor', { kind: 'info', icon: 'pointer',
      title: on ? "This computer's pointer is hidden." : "This computer's pointer is back.",
      body: on ? 'Only your Mac\u2019s pointer shows now. Press Esc twice quickly to bring this one back.' : '', dismissible: true });
    clearTimeout(this.cursorNoteTimer);
    this.cursorNoteTimer = setTimeout(() => this.banners.hide('cursor'), 4000);
  }

  // --- swipes ---

  _swipe(dir) {
    if (!this.inputAllowed || this.over) return;
    if (dir === 'up' || dir === 'down') return this._pressId(dir === 'up' ? 'missionControl' : 'appWindows');
    const mode = this.prefs.get('swipe');
    if (mode === 'apps') return this._appSwitch(dir);
    const a = SWIPE_ACTIONS[mode];
    if (a?.next) this._pressId(dir > 0 ? a.next : a.prev);
  }

  _pressId(id) {
    const s = findShortcut(id, this.customKeys);
    if (s) for (const m of pressMessages(s.code, s.key, s.m)) this.session.sendInput(m);
  }

  // ⌘ stays held between swipes, so the app switcher stays up and each swipe moves along it; let go a moment later.
  _appSwitch(dir) {
    const send = m => this.session.sendInput(m);
    if (!this.cmdHeld) {
      send({ t: 'k', c: 'MetaLeft', k: 'Meta', d: true, m: META });
      this.cmdHeld = true;
    }
    const m = META | (dir < 0 ? SHIFT : 0);
    if (dir < 0) send({ t: 'k', c: 'ShiftLeft', k: 'Shift', d: true, m });
    send({ t: 'k', c: 'Tab', k: 'Tab', d: true, m });
    send({ t: 'k', c: 'Tab', k: 'Tab', d: false, m });
    if (dir < 0) send({ t: 'k', c: 'ShiftLeft', k: 'Shift', d: false, m: META });
    clearTimeout(this.cmdTimer);
    this.cmdTimer = setTimeout(() => this._releaseCmd(), 1000);
  }

  _releaseCmd() {
    clearTimeout(this.cmdTimer);
    if (!this.cmdHeld) return;
    this.cmdHeld = false;
    this.session.sendInput({ t: 'k', c: 'MetaLeft', k: 'Meta', d: false, m: 0 });
  }

  // --- the keys bar: which keys it has, and the editor for choosing them ---

  _wireKeysBar() {
    const $ = this.$;
    this._renderKeys();
    this._on($('keysEdit'), 'click', () => this._openKeysEditor());
    this._on($('optEditKeys'), 'click', () => this._openKeysEditor());
    this._on($('keysEditorDone'), 'click', () => this._closeKeysEditor());
    this._on($('keysEditor'), 'keydown', e => { if (e.key === 'Escape') { e.preventDefault(); this._closeKeysEditor(); } });
    this._on($('keysReset'), 'click', () => {
      this.prefs.set('keysBar', [...DEFAULT_BAR]);
      this._renderKeys();
      this._renderKeysEditor();
    });
    $('keOwnKey').replaceChildren(...CUSTOM_KEYS.map(([code, , label]) => {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = label;
      return o;
    }));
    this._on($('keOwnAdd'), 'click', () => {
      const m = [...$('keysEditor').querySelectorAll('.ke-own input[type=checkbox]:checked')].reduce((a, i) => a | Number(i.value), 0);
      const c = makeCustom($('keOwnKey').value, m, $('keOwnName').value);
      if (!c) return;
      const own = [...this.customKeys.filter(x => x.id !== c.id), c];
      this.prefs.set('customKeys', own.map(({ code, m, name }) => ({ code, m, name })));
      this.prefs.set('keysBar', toggleOnBar(this.bar, c.id, true));
      $('keOwnName').value = '';
      this._renderKeys();
      this._renderKeysEditor();
    });

    // Swipes.
    const sw = $('optSwipe');
    sw.replaceChildren(...Object.entries(SWIPE_ACTIONS).map(([v, a]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = a.label;
      return o;
    }));
    sw.value = this.prefs.get('swipe') in SWIPE_ACTIONS ? this.prefs.get('swipe') : 'apps';
    this._on(sw, 'change', () => this.prefs.set('swipe', sw.value));

    // This computer's pointer (only with a mouse or touchpad).
    $('hideCursorWrap').hidden = !!this.touchFirst || this.guest;
    this._on($('optHideCursor'), 'change', e => this._setHideCursor(e.target.checked));
    if (this.prefs.get('hideCursor')) this._setHideCursor(true, { note: false });
  }

  _renderKeys() {
    this.customKeys = cleanCustom(this.prefs.get('customKeys'));
    this.bar = cleanBar(this.prefs.get('keysBar'), this.customKeys);
    this.$('keysList').replaceChildren(...this.bar.map(id => {
      const s = findShortcut(id, this.customKeys);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'key' + (s.label.length > 2 ? ' wide' : '');
      b.dataset.key = id;
      b.textContent = s.label;
      b.title = s.title;
      if (s.title !== s.label) b.setAttribute('aria-label', s.title);
      return b;
    }));
  }

  _openKeysEditor() {
    this._toggleMenu(false);
    const bar = this.$('keysBar');
    bar.hidden = false;
    this.$('tbKeys').setAttribute('aria-pressed', 'true');
    this._renderKeysEditor();
    this.$('keysEditor').hidden = false;
    this.$('keysEditorDone').focus({ preventScroll: true });
  }

  _closeKeysEditor() {
    const ed = this.$('keysEditor');
    if (ed.hidden) return;
    ed.hidden = true;
    this.surface.focus({ preventScroll: true });
  }

  _renderKeysEditor() {
    const on = new Set(this.bar);
    const choice = (s, extra) => {
      const label = document.createElement('label');
      label.className = 'ke-item';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = on.has(s.id);
      box.addEventListener('change', () => {
        this.prefs.set('keysBar', toggleOnBar(this.bar, s.id, box.checked));
        this._renderKeys();
      });
      const b = document.createElement('b');
      b.textContent = s.label;
      const t = document.createElement('span');
      t.textContent = s.title === s.label ? '' : s.title;
      label.append(box, b, t);
      if (extra) label.append(extra);
      return label;
    };
    const groups = [];
    for (const g of [...GROUPS, 'Yours']) {
      const items = g === 'Yours' ? this.customKeys : CATALOG.filter(s => s.group === g);
      if (!items.length) continue;
      const fs = document.createElement('fieldset');
      const lg = document.createElement('legend');
      lg.textContent = g === 'Yours' ? 'Your own' : g;
      fs.append(lg);
      if (g === 'Function keys') {
        const all = document.createElement('button');
        all.type = 'button';
        all.className = 'btn small quiet ke-all';
        const every = FUNCTION_KEYS.every(id => on.has(id));
        all.textContent = every ? 'Take F1–F12 off' : 'Put all of F1–F12 on';
        all.addEventListener('click', () => {
          let bar = this.bar;
          for (const id of FUNCTION_KEYS) bar = toggleOnBar(bar, id, !every);
          this.prefs.set('keysBar', bar);
          this._renderKeys();
          this._renderKeysEditor();
        });
        fs.append(all);
      }
      for (const s of items) {
        let extra;
        if (g === 'Yours') {
          extra = document.createElement('button');
          extra.type = 'button';
          extra.className = 'ke-x';
          extra.textContent = '×';
          extra.setAttribute('aria-label', `Remove ${s.label}`);
          extra.addEventListener('click', e => {
            e.preventDefault();
            this.prefs.set('customKeys', this.customKeys.filter(x => x.id !== s.id).map(({ code, m, name }) => ({ code, m, name })));
            this.prefs.set('keysBar', toggleOnBar(this.bar, s.id, false));
            this._renderKeys();
            this._renderKeysEditor();
          });
        }
        fs.append(choice(s, extra));
      }
      groups.push(fs);
    }
    this.$('keysGroups').replaceChildren(...groups);
  }

  _showToolbar() {
    this.root.classList.add('tb-on');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this._hideToolbar(), HIDE_AFTER_MS);
  }

  _hideToolbar(now = false) {
    const tb = this.$('toolbar');
    const busy = !now && (!this.$('moreMenu').hidden || tb.matches(':hover') || tb.contains(document.activeElement));
    if (busy) {
      this.hideTimer = setTimeout(() => this._hideToolbar(), HIDE_AFTER_MS);
      return;
    }
    this.root.classList.remove('tb-on');
  }

  _toolbarKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    this._toggleMenu(false);
    this.surface.focus({ preventScroll: true });
  }

  _ownShortcut(e) {
    if (this.over) return;
    // A hidden pointer comes back with Esc twice (the first Esc still goes to the Mac).
    if (e.key === 'Escape' && !e.repeat && this.root.classList.contains('nocursor') && !this.pointer?.locked) {
      if (e.timeStamp - (this.lastEsc ?? -Infinity) < DOUBLE_ESC_MS) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.lastEsc = null;
        this._setHideCursor(false);
        return;
      }
      this.lastEsc = e.timeStamp;
    }
    if (!(e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyT')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this._showToolbar();
    this.$('tbQuality').focus();
  }

  _activity(e) {
    // The first touch or click after the toolbar went away shouldn't bring it back (it would cover what you tapped).
    if (e?.type === 'pointerdown') this._toggleMenu(false);
  }

  // --- the phone keyboard button ---

  // Always on screen on touch devices (the toolbar, with its own keyboard button, tucks itself away). Its invisible
  // text box takes the tap itself, so the phone sees a tap on a real text field and opens its keyboard; a tap while
  // the keyboard is open closes it. The special keys (⌘, Esc, arrows…) come up with the keyboard.
  _wireKeyboardButton() {
    const fab = this.$('kbdFab'), box = this.$('softkbd'), bar = this.$('keysBar'), keysBtn = this.$('tbKeys');
    let barWasHidden = true;
    const closeIfOpen = e => {
      if (document.activeElement !== box) return;
      e.preventDefault();
      box.blur();
    };
    this._on(box, 'touchstart', closeIfOpen, { passive: false });
    this._on(box, 'mousedown', closeIfOpen);
    this._on(box, 'focus', () => {
      // Opened by itself for a text box on the Mac, or by hand with this button.
      this.autoKeyboard = this.openingAuto === true;
      this.openingAuto = false;
      this._inviteKeyboard(null);
      fab.classList.add('open');
      fab.setAttribute('aria-label', 'Hide the keyboard');
      barWasHidden = bar.hidden;
      bar.hidden = false;
      keysBtn.setAttribute('aria-pressed', 'true');
    });
    this._on(box, 'blur', () => {
      fab.classList.remove('open');
      fab.setAttribute('aria-label', 'Show the keyboard');
      if (barWasHidden) {
        bar.hidden = true;
        keysBtn.setAttribute('aria-pressed', 'false');
      }
    });
    this._syncKeyboardButton();
  }

  // The Mac says whether the last tap left it waiting for typing. Bring the keyboard up for a text box (where the
  // browser lets a page do that), or invite a tap on the keyboard button (iPhones and iPads only open it for a tap);
  // put it away again after a tap elsewhere, if it came up by itself.
  _textFocus(editable, secure) {
    if (!this.touchFirst || !this.inputAllowed || this.over) return;
    const box = this.$('softkbd');
    if (!editable) {
      if (!this.status.locked) this._inviteKeyboard(null);
      if (this.autoKeyboard && document.activeElement === box) this.keys.hideSoftKeyboard();
      return;
    }
    if (document.activeElement === box) return;
    if (canOpenKeyboardNow()) {
      this.openingAuto = true;
      this.keys.showSoftKeyboard();
      if (document.activeElement === box) return;
      this.openingAuto = false;
    }
    this._inviteKeyboard(secure ? 'Tap to type the password' : 'Tap to type');
  }

  _inviteKeyboard(text, { stay = false } = {}) {
    const fab = this.$('kbdFab');
    clearTimeout(this.inviteTimer);
    fab.classList.toggle('invite', !!text && !fab.hidden);
    this.$('kbdFabLabel').textContent = text ?? '';
    if (text && !stay) this.inviteTimer = setTimeout(() => this._inviteKeyboard(null), 8000);
  }

  _syncKeyboardButton() {
    const fab = this.$('kbdFab');
    fab.hidden = !(this.touchFirst && this.inputAllowed);
    // Locked: typing the password is the next thing to do.
    if (!fab.hidden && this.status.locked && document.activeElement !== this.$('softkbd')) {
      this._inviteKeyboard('Tap to type the password', { stay: true });
    }
    if (fab.hidden && document.activeElement === this.$('softkbd')) this.$('softkbd').blur();
  }

  // --- full screen ---

  _toggleFullscreen() {
    const d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d)?.catch?.(() => {});
      return;
    }
    const el = this.root;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    Promise.resolve(req?.call(el, { navigationUI: 'hide' })).then(() => {
      // In full screen Chrome and Edge can pass every key to the page, even ⌘W and Esc (Keyboard Lock API).
      navigator.keyboard?.lock?.().catch(() => {});
    }, () => {});
  }

  _fullscreenChanged() {
    const full = !!(document.fullscreenElement || document.webkitFullscreenElement);
    const b = this.$('tbFull');
    setIcon(b, full ? 'fullscreen-exit' : 'fullscreen');
    b.setAttribute('aria-label', full ? 'Leave full screen' : 'Full screen');
    b.title = full ? 'Leave full screen' : 'Full screen';
    if (!full) navigator.keyboard?.unlock?.();
    this.setView(this.view);
  }

  // --- small helpers ---

  _on(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    this.listeners.push([el, type, fn, opts]);
  }

  _every(ms, fn) { this.timers.push(setInterval(fn, ms)); }

  _clearTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

// Whether this browser will open its on-screen keyboard for a text field focused by the page itself, now: only just
// after the person touched the screen, and never on iPhones and iPads (they insist on a tap on the field itself).
function canOpenKeyboardNow() {
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return !apple && navigator.userActivation?.isActive === true;
}

// A Blob as base64 (no data: prefix).
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

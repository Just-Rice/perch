// The signed-in screen: the PC's picture and sound filling the window, and Roost's controls floating over it:
//   - the Dock (a pill that snaps to any edge or corner, and shrinks to an orb; viewer/dock.js says where it can go);
//   - the Command palette (every action and setting, searchable; viewer/palette.js);
//   - Tweaks (a slide-over panel of settings);
//   - the Key deck (Win, Ctrl, Alt, Shift and chosen keys, for phones above all; viewer/shortcuts.js).
// Input goes through viewer/pointer.js and viewer/keyboard.js.
//
// `session` is a ui/connection.js Connection (or the demo's stand-in, ui/demo.js) with send(), sendInput(),
// sendPointer(), getStats(), stream and the onstream / onmessage / onlink hooks.
import { PointerInput } from './pointer.js';
import { KeyboardInput } from './keyboard.js';
import { Banners } from './banners.js';
import { Palette } from './palette.js';
import { ANCHORS, nearestAnchor, stepAnchor, isVertical, anchorEdge, onRight } from './dock.js';
import { readStats, summarize, linkQuality, QUALITY_WORDS, statsLines, selectedRoute } from './stats.js';
import { IDENTITY, isZoomed, viewTransform, clampView, SHAPES, CENTER, shownScale } from './coords.js';
import { arrangement, neighbour, entryPoint, EdgeFlip, EDGE_DWELL_MS } from './displays.js';
import { errorMessage } from '../ui/messages.js';
import { fillIcons, setIcon } from '../ui/icons.js';
import { QUALITY } from '../shared/proto.js';
import { pressMessages, SHIFT, ALT } from './keys.js';
import {
  GROUPS, CATALOG, DEFAULT_BAR, FUNCTION_KEYS, CUSTOM_KEYS, SWIPE_ACTIONS, makeCustom, cleanCustom, cleanBar, findShortcut, toggleOnBar,
} from './shortcuts.js';

const IDLE_AFTER_MS = 3500;  // the Dock shrinks or tucks itself away after this long without being used (if chosen)
const EDGE_ZONE_PX = 6;      // a tucked-away Dock comes back when the mouse touches its edge (this close to it), and only then
const DRAG_PX = 5;           // a press on the Dock's grip that moves further than this is a drag
const DOUBLE_ESC_MS = 600;   // Esc twice within this brings back a hidden pointer
const PING_MS = 2000;
const MAX_CLIP = 30000; // clipboard text, either way (the PC has the same limit)
const MAX_CLIP_IMAGE = 20 * 1024 * 1024; // clipboard pictures, either way (the PC has the same limit)
const CLIP_PART = 48 * 1024;             // base64 characters per piece of a picture
const CLIP_BACKLOG = 2 * 1024 * 1024;    // pieces wait while this much is still queued on the connection
const PASTE_WAIT_MS = 400;               // after Ctrl+V, how long the browser's paste event gets before the PC pastes its own

const QUALITY_TEXT = {
  smooth: ['Smooth', 'Less data, a softer picture'],
  balanced: ['Balanced', 'Sharp enough, moves well'],
  sharp: ['Sharp', 'Small text stays crisp'],
  fast: ['60 frames a second', 'For fast links and games'],
};
const SHAPE_TEXT = { fit: 'Whole screen', fill: 'Fill this screen', stretch: 'Stretch to fill' };
const ANCHOR_TEXT = {
  'top-left': 'top left', top: 'top', 'top-right': 'top right', left: 'left', right: 'right',
  'bottom-left': 'bottom left', bottom: 'bottom', 'bottom-right': 'bottom right',
};
const IDLE_TEXT = { stay: 'Stay as it is', orb: 'Shrink to an orb', hide: 'Tuck away at the edge' };

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
    this.windows = [];
    this.idleTimer = null;
  }

  mount() {
    const { root, session } = this;
    root.hidden = false;
    root.classList.toggle('touch', !!this.touchFirst);
    root.classList.toggle('guest', this.guest);
    document.body.classList.add('viewing');
    fillIcons(root);
    this.video = this.$('video');
    this.surface = this.$('surface');
    this.zoomEl = this.$('zoom');
    this.banners = new Banners(this.$('banners'));
    this.banners.clear();
    this.$('ended').hidden = true;
    this.$('stats').hidden = !this.prefs.get('stats');
    this.$('optStats').checked = !this.$('stats').hidden;

    const attach = stream => {
      if (this.video.srcObject !== stream) this.video.srcObject = stream;
      this._play();
    };
    if (session.stream) attach(session.stream);
    session.onstream = attach;
    session.onmessage = m => this._message(m);
    session.onlink = state => {
      if (state === 'disconnected') {
        this.banners.show('link', { kind: 'warn', icon: 'refresh', title: 'Reconnecting…', body: 'The connection to your PC dropped for a moment.' });
      } else {
        this.banners.hide('link');
      }
    };

    this._wireDock();
    this._wireTweaks();
    this._wirePalette();
    const enabled = () => this.inputAllowed && !this.over;
    const activity = e => this._activity(e);
    this.pointer = new PointerInput({
      surface: this.surface, video: this.video, session,
      view: { get: () => this.view, set: v => this.setView(v) },
      layout: { get: () => ({ shape: this._shape(), pan: this.pan }), pan: p => this._setPan(p) },
      size: () => [this.display.width || 0, this.display.height || 0],
      enabled, onActivity: activity, touchpad: () => this.touchFirst && !!this.prefs.get('touchpad'),
      onSwipe: dir => this._swipe(dir),
      swipesOn: () => this.inputAllowed && this.prefs.get('swipe') in SWIPE_ACTIONS && this.prefs.get('swipe') !== 'off',
      mouseSpeed: () => this.prefs.get('mouseSpeed'),
      onEdge: (p, push, locked) => this._edge(p, push, locked),
    });
    this.keys = new KeyboardInput({
      surface: this.surface, softkbd: this.$('softkbd'), keysBar: this.$('keysBar'), session,
      swapCtrlCmd: () => !!this.prefs.get('swapCtrlCmd'), enabled, onActivity: activity,
      shortcut: id => findShortcut(id, this.customKeys),
      onPasteKey: () => this._pasteKey(),
    });
    // Ctrl+V on the picture: this device's clipboard, text or picture, is pasted on the PC.
    this._on(window, 'paste', e => this._onPaste(e), true);
    // A copy from the PC that couldn't be written here (this page didn't have focus) is written once it does.
    this._on(window, 'focus', () => this._retryMirror());
    this._on(window, 'pointerdown', () => this._retryMirror(), true);
    // Our own shortcuts first, before the keys go to the PC: Ctrl+Alt+Shift+K opens the Command palette, and
    // Ctrl+Alt+Shift+T brings the Dock to the keyboard.
    this._on(window, 'keydown', e => this._ownShortcut(e), true);
    this.pointer.attach();
    this.keys.attach();
    this._wireKeyboardButton();
    this._wireKeysBar();
    this._wirePlacement();
    this._wireShape();

    this._applyStatus({ locked: this.ready.locked, input: this.ready.input });
    const q = this.prefs.get('quality');
    this._showQuality(q in QUALITY && !this.guest ? q : this.ready.quality);
    if (!this.guest && q in QUALITY && q !== this.ready.quality) session.send({ t: 'quality', preset: q });

    this._every(PING_MS, () => this._ping());
    this._every(1000, () => this._stats());
    this._ping();
    // Keep this device's screen on while the PC is on it (phones dim and lock after a minute or so).
    this._keepAwake();
    this._on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') this._keepAwake(); });
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const fit = () => {
        // iPhones don't shrink the page for the on-screen keyboard; lift the Key deck above it ourselves.
        const below = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
        root.style.setProperty('--kb-inset', `${Math.round(below)}px`);
      };
      this._on(vv, 'resize', fit);
      this._on(vv, 'scroll', fit);
      fit();
    }
    this._on(window, 'resize', () => { this.setView(this.view); this._reportView(); this._placePops(); });
    this._on(this.video, 'resize', () => { this._reportView(); this._shapeUi(); }); // the picture's own size or shape changed
    this._reportView();
    this._on(document, 'fullscreenchange', () => this._fullscreenChanged());
    this._on(document, 'webkitfullscreenchange', () => this._fullscreenChanged());
    this.surface.focus({ preventScroll: true });
    this._showDock();
  }

  // The session ended (the PC said bye, the network went): freeze the picture and say what happened.
  ended(m, { canReconnect = true } = {}) {
    this.gone = true;
    if (this.over) return;
    this._releaseAlt();
    this.over = true;
    this._micOff();
    this._letSleep();
    if (document.pointerLockElement === this.surface) document.exitPointerLock();
    this.keys?.releaseAll();
    this._clearTimers();
    this._closeOverlays();
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
    this._releaseAlt();
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.placeFrame);
    if (document.pointerLockElement === this.surface) document.exitPointerLock();
    for (const t of ['captureNoteTimer', 'hideNoteTimer', 'inviteTimer', 'idleTimer', 'viewTimer', 'clipNoteTimer', 'cursorNoteTimer']) clearTimeout(this[t]);
    this.pointer?.detach();
    this.keys?.detach();
    this.palette?.detach();
    for (const [el, type, fn, opts] of this.listeners) el.removeEventListener(type, fn, opts);
    this.listeners = [];
    this._clearTimers();
    this._micOff();
    if (this.session) { this.session.onmessage = this.session.onstream = this.session.onlink = this.session.onmicended = () => {}; }
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.setView(IDENTITY);
    this.banners?.clear();
    for (const id of ['ended', 'tweaks', 'palette', 'scrim', 'displayMap', 'keysBar', 'keysEditor', 'soundPrompt', 'clipSheet', 'orb', 'dockLip']) this.$(id).hidden = true;
    this.clipWaiter = null;
    this.$('dkKeys').setAttribute('aria-pressed', 'false');
    this._inviteKeyboard(null);
    // The browser says the mouse is let go only after these listeners are gone: don't leave the pointer hidden.
    this.root.classList.remove('zoomed', 'captured', 'touchpad', 'touch', 'guest', 'view-only', 'nocursor', 'dock-vertical',
      'dock-orb', 'dock-away', 'dragging', 'deck-on', 'tweaks-left', 'no-anim', ...ANCHORS.map(a => `at-${a}`), ...SHAPES.map(s => `shape-${s}`));
    for (const v of ['--room-top', '--room-bottom', '--room-left', '--room-right', '--keys-h', '--keys-up']) this.root.style.removeProperty(v);
    this.root.hidden = true;
    document.body.classList.remove('viewing');
    navigator.keyboard?.unlock?.();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }

  // Local zoom: a CSS transform on the picture's wrapper. Nothing changes on the PC.
  setView(v) {
    const box = this.surface.getBoundingClientRect();
    this.view = clampView(v, box);
    this.zoomEl.style.transform = viewTransform(this.view);
    const zoomed = isZoomed(this.view);
    if (this.pointer) this._reportView();
    this.root.classList.toggle('zoomed', zoomed);
    this.$('optZoom').disabled = !zoomed;
  }

  // --- messages from the PC ---

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
      // The PC couldn't play the microphone (its sound output went away), or stopped it.
      if (m.on === false && this.micOn) {
        this._micOff();
        this.banners.show('mic', { kind: 'warn', icon: 'warn', title: "Your PC couldn't play your microphone.",
          body: "Check the sound output chosen in Roost's Control Center on the PC.", dismissible: true });
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
        this.banners.show('locked', { kind: 'info', icon: 'lock', title: 'Your PC is locked.',
          body: "You can type its PIN or password here; if that doesn't work, unlock it at the PC." });
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
            body: "You can see and hear this PC, but you can't control it.", dismissible: true });
        }
      } else if (!this.inputAllowed) {
        this.banners.show('viewonly', { kind: 'warn', icon: 'eye', title: 'View only.',
          body: "Roost can't control your PC right now. Check Roost is running on the PC and open its Control Center there." });
      } else {
        this.banners.hide('viewonly');
      }
    }
    if ('link' in st) {
      if (st.link === 'slow') {
        const smooth = this.quality === 'smooth';
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
    if (st.levels && typeof st.levels === 'object') this._showLevels(st.levels);
    // Which window is being shown, if any. Just after choosing one here the PC's older notes still say otherwise.
    if ('window' in st && performance.now() >= (this.windowChosenAt ?? -Infinity) + 1500) this._showWindow(st.window ?? null);
  }

  // --- clipboard text ---

  // Paste this device's clipboard on the PC: straight away where the browser lets the page read it, otherwise
  // through a box to paste into (iPhones without a prompt, Firefox, a refusal).
  async _pasteToPc() {
    this._closeOverlays();
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
    if (!text) { this._clipStatus('There’s no text to send.'); return; }
    if (text.length > MAX_CLIP) { this._clipStatus('That text is too long to send in one go.'); return; }
    this.clipPasting = paste;
    this.session.send({ t: 'clip-set', text, paste });
  }

  _clipSetDone(ok) {
    if (this.clipPasting === 'key') {
      // From Ctrl+V or Paste on the PC: now the PC pastes it.
      this.clipPasting = null;
      if (ok) {
        this.keys.pasteKey();
        if (this.clipSentImage) this._clipNote('Pasted on your PC.', 'paste');
      } else {
        this._clipNote('Your PC didn’t take that.', 'paste');
      }
      return;
    }
    if (!ok) {
      if (this.$('clipSheet').hidden) this._openClip('send', '');
      this._clipStatus('Your PC didn’t take that text.');
      return;
    }
    this._closeClip();
    this._clipNote(this.clipPasting ? 'Pasted on your PC.' : 'On your PC’s clipboard.', this.clipPasting ? 'paste' : 'copy');
  }

  // --- the clipboard without the box: Ctrl+V pastes this device's clipboard, and copies on the PC come here ---

  // Ctrl+V on the picture. True: wait for the browser's paste event (and if none comes, the PC pastes its own).
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

  // Puts text and/or a picture on the PC's clipboard, then presses Ctrl+V there. Nothing here: the PC pastes its own.
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
      if (file.size > 1024 * 1024) this._clipNote('Sending the picture…', 'paste', 0);
      let b64;
      try { b64 = await blobToBase64(file); } catch { this._clipNote('Couldn’t read that picture.', 'paste'); return; }
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

  // Just copied on the PC: onto this device's clipboard too.
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
    const note = img ? 'Picture copied from your PC.' : 'Copied from your PC.';
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

  // Copy the PC's clipboard to this device. Browsers only let a page write the clipboard during a click, and the
  // PC's answer comes a moment later, so the write is started now with the text still on its way (ClipboardItem
  // takes a promise); where that isn't possible the text is shown, selected, to copy by hand.
  _copyFromPc() {
    this._closeOverlays();
    const answer = new Promise(resolve => {
      this.clipWaiter = resolve;
      setTimeout(() => resolve({ ok: false, timeout: true }), 5000);
    });
    this.session.send({ t: 'clip-get' });
    // An empty PC clipboard leaves this device's clipboard as it is.
    const text = answer.then(m => (m.ok && typeof m.text === 'string' && m.text ? m.text : Promise.reject(new Error('no text'))));
    const done = n => this._clipNote(n ? 'Copied from your PC.' : 'Your PC’s clipboard has no text.', 'copy');
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

  // The box for clipboard text: 'send' (to the PC) or 'show' (the PC's text, to copy by hand).
  _openClip(mode, error, text = '') {
    const $ = this.$;
    const show = mode === 'show';
    $('clipTitle').textContent = show ? 'Your PC’s clipboard' : 'Send text to your PC';
    $('clipHelp').textContent = show ? 'This browser can’t copy it by itself. It’s selected: copy it from here.'
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

  // --- the microphone: what you say here is played on the PC ---

  async _toggleMic() {
    if (this.micOn) {
      this._micOff();
      this.session.send({ t: 'mic', on: false });
      return;
    }
    if (this.micBusy) return;
    this.micBusy = true;
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
    this.$('optMic').lastChild.textContent = 'Stop talking through your PC';
    this.banners.show('mic', { kind: 'info', icon: 'mic', title: 'Your microphone is on.',
      body: 'Your PC is playing what you say.', action: { label: 'Turn off', onClick: () => this._toggleMic() } });
  }

  // Off on this side (the PC is told separately, when it doesn't already know).
  _micOff() {
    if (!this.micOn) return;
    this.micOn = false;
    this.session.stopMic?.();
    this.$('optMic').setAttribute('aria-pressed', 'false');
    this.$('optMic').lastChild.textContent = 'Talk through your PC';
    this.banners.hide('mic');
  }

  // --- one window ---

  // The windows on the PC right now, asked for each time Tweaks or the Command palette opens.
  _setWindows(list) {
    this.windows = list.filter(w => Number.isInteger(w?.id)).map(w => ({ id: w.id, name: windowName(w) }));
    const sel = this.$('optWindow');
    const whole = document.createElement('option');
    whole.value = '';
    whole.textContent = 'The whole screen';
    sel.replaceChildren(whole, ...this.windows.map(w => {
      const o = document.createElement('option');
      o.value = String(w.id);
      o.textContent = w.name;
      return o;
    }));
    // The one being shown may have gone from the list (it was closed); the PC says so in its next note.
    sel.value = this.windowId != null && [...sel.options].some(o => o.value === String(this.windowId)) ? String(this.windowId) : '';
    if (this.palette?.open) this.palette.render();
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
    const id = value === '' || value === null ? null : Number(value);
    if (id !== null && !Number.isInteger(id)) return;
    this.windowChosenAt = performance.now();
    this._showWindow(id);
    this.session.send({ t: 'window', id });
  }

  // Reshape the window on the PC to this screen's shape, so it fills the screen here.
  _fitWindow() {
    const box = this.surface.getBoundingClientRect();
    if (this.windowId == null || !(box.width > 0 && box.height > 0)) return;
    this.session.send({ t: 'fit', w: Math.round(box.width), h: Math.round(box.height) });
    this._closeOverlays();
  }

  _askWindows() {
    if (this.canWindow) this.session.send({ t: 'windows' });
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
    const orb = this.$('orb');
    orb.classList.toggle('q-fair', q === 'fair');
    orb.classList.toggle('q-poor', q === 'poor');
    orb.setAttribute('aria-label', `Show the Dock (${QUALITY_WORDS[q].toLowerCase()})`);
    const panel = this.$('stats');
    if (panel.hidden) return;
    const route = this.session.via === 'relay' ? 'worker' : selectedRoute(report);
    const lines = statsLines(sum, { pingMs: this.pingMs, decoder: snap.video?.decoder, route });
    if (this.status.fps != null || this.status.kbps != null) {
      lines.push(['PC sends', `${this.status.fps ?? '–'} fps, ${this.status.kbps ?? '–'} kbit/s`]);
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

  _setStats(on) {
    const panel = this.$('stats');
    panel.hidden = !on;
    this.prefs.set('stats', on);
    this.$('optStats').checked = on;
    if (on) this._stats();
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
    // Over the Worker relay the picture plays but the sound waits for a tap (the browser paused its audio context):
    // say so, the same way. Any tap or key starts it; the prompt goes once it has.
    if (hasAudio && !this.prefs.get('muted') && this.session.media?.soundPaused) {
      this.$('soundPrompt').hidden = false;
      const check = () => {
        if (this.session.media?.soundPaused) return;
        this.$('soundPrompt').hidden = true;
        clearInterval(this.soundCheck);
      };
      clearInterval(this.soundCheck);
      this.soundCheck = setInterval(check, 500);
      this.timers.push(this.soundCheck);
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
    const b = this.$('dkSound');
    b.hidden = !has;
    this.$('optVolume').closest('label').hidden = !has || this.touchFirst;
    setIcon(b, v.muted ? 'muted' : 'sound');
    b.setAttribute('aria-label', v.muted ? 'Turn sound on' : 'Mute');
    b.title = v.muted ? 'Sound is off' : 'Sound is on';
    this.$('soundWrap').hidden = !has;
    this.$('optSound').checked = !v.muted;
    this.$('optVolume').value = String(v.volume ?? 1);
    this.$('optVolumeOut').textContent = `${Math.round((v.volume ?? 1) * 100)}%`;
  }

  _setMuted(muted) {
    const v = this.video;
    v.muted = muted;
    this.prefs.set('muted', muted);
    if (!muted) v.play().catch(() => {});
    // Over the Worker relay the sound comes from an audio context the browser may have paused: this tap starts it.
    if (!muted) this.session.media?.resume?.();
    this.$('soundPrompt').hidden = true;
    this._soundUi();
  }

  // --- the Dock's buttons ---

  _wireDock() {
    const $ = this.$;
    $('dockName').textContent = this.ready.name || this.hi.name || 'your PC';
    $('dockGrip').setAttribute('aria-label', `${this.ready.name || this.hi.name || 'Your PC'}: move the Dock (arrow keys)`);
    const on = (id, type, fn) => this._on($(id), type, fn);

    // A guest only watches: nothing here that would change the PC or what it sends.
    $('dkKeys').hidden = this.guest;

    // Which display: the Dock's display button opens the map, with a button for each display (shaped like it).
    this.edgeFlip = new EdgeFlip((edge, along) => (this.guest ? null : neighbour(this.displays ?? [], this._shownDisplay(), edge, along)));
    this._setDisplays(Array.isArray(this.ready.displays) ? this.ready.displays : [], this.display.id);
    on('dkDisplay', 'click', () => this._toggleDisplayMap());
    this._on($('displayMap'), 'keydown', e => { if (e.key === 'Escape') { e.preventDefault(); this._toggleDisplayMap(false); $('dkDisplay').focus(); } });

    $('dkKeyboard').hidden = !this.touchFirst || this.guest;
    // pointerdown keeps the phone keyboard's focus while the button is pressed, so the button can toggle it.
    on('dkKeyboard', 'pointerdown', e => e.preventDefault());
    on('dkKeyboard', 'click', () => {
      if (this.keys.softKeyboardOpen) this.keys.hideSoftKeyboard(); else this.keys.showSoftKeyboard();
    });
    on('dkKeys', 'click', () => this._setDeck($('keysBar').hidden));

    on('dkSound', 'click', () => this._setMuted(!this.video.muted));
    on('soundPrompt', 'click', () => this._setMuted(false));

    const canFull = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    $('dkFull').hidden = !canFull;
    on('dkFull', 'click', () => this._toggleFullscreen());

    // Capture the mouse, as games do: this computer's pointer disappears and the mouse moves only the PC's.
    this.canCapture = !this.touchFirst && !this.guest && 'requestPointerLock' in this.surface;
    $('dkCapture').hidden = !this.canCapture;
    on('dkCapture', 'click', () => (this.pointer?.locked ? document.exitPointerLock() : this._capture()));
    this._on(this.surface, 'pointerdown', e => {
      if (this.canCapture && e.pointerType === 'mouse' && !this.pointer?.locked && this.prefs.get('captureOnClick') && this.inputAllowed) this._capture();
    });
    this._on(document, 'pointerlockchange', () => {
      const locked = document.pointerLockElement === this.surface;
      $('dkCapture').setAttribute('aria-pressed', String(locked));
      $('dkCapture').setAttribute('aria-label', locked ? 'Let go of the mouse' : 'Capture the mouse');
      this.root.classList.toggle('captured', locked);
      if (locked) {
        this._closeOverlays();
        this.banners.show('capture', { kind: 'info', icon: 'pointer', title: 'The mouse is captured.',
          body: 'It moves only your PC’s pointer. Press Esc to let go.', dismissible: true });
        clearTimeout(this.captureNoteTimer);
        this.captureNoteTimer = setTimeout(() => this.banners.hide('capture'), 4000);
      } else {
        this.banners.hide('capture');
      }
    });
    this._on(document, 'pointerlockerror', () => {
      this.banners.show('capture', { kind: 'warn', icon: 'warn', title: "This browser didn't let Roost capture the mouse.",
        body: 'Click the PC’s screen first, then try again.', dismissible: true });
    });

    on('dkPalette', 'click', () => this._togglePalette());
    on('dkTweaks', 'click', () => this._toggleTweaks());
    on('dkOrb', 'click', () => this._toOrb());
    on('dkBye', 'click', () => this.onLeave());
    on('orb', 'click', () => {
      if (this.orbDragged) return;
      this._fromOrb();
      $('dkPalette').focus({ preventScroll: true });
    });
    on('dockLip', 'click', () => this._showDock());

    const dock = $('dock');
    this._on(dock, 'focusin', () => this._showDock());
    this._on(dock, 'pointerenter', () => this._showDock());
    this._on(dock, 'pointerleave', () => this._showDock());
    // On the whole viewer: a Dock tucked away comes back when the mouse touches the very edge it went past.
    this._on(this.root, 'pointermove', e => {
      if (e.pointerType === 'touch' || this.pointer?.locked || !this.root.classList.contains('dock-away')) return;
      const box = this.root.getBoundingClientRect();
      const near = { top: e.clientY - box.top < EDGE_ZONE_PX, bottom: box.bottom - e.clientY < EDGE_ZONE_PX,
        left: e.clientX - box.left < EDGE_ZONE_PX, right: box.right - e.clientX < EDGE_ZONE_PX };
      if (near[anchorEdge(this._at())]) this._showDock();
    });
    // A tap or click on the picture closes whatever was open over it.
    this._on(this.surface, 'pointerdown', () => this._closeOverlays());
    this._on($('scrim'), 'pointerdown', e => { e.preventDefault(); this._closeOverlays({ focus: true }); });
    this._on(document, 'pointerdown', e => {
      if (!$('displayMap').hidden && !e.target.closest?.('#displayMap, #dkDisplay')) this._toggleDisplayMap(false);
    }, true);
  }

  // --- Tweaks: the slide-over panel ---

  _wireTweaks() {
    const $ = this.$;
    const on = (id, type, fn) => this._on($(id), type, fn);
    on('tweaksClose', 'click', () => this._toggleTweaks(false));
    this._on($('tweaks'), 'keydown', e => { if (e.key === 'Escape') { e.preventDefault(); this._toggleTweaks(false); } });

    // Picture quality, with 60 frames a second on PCs that offer it. A guest can't change what the PC sends.
    $('qualityGroup').hidden = this.guest;
    $('qFastWrap').hidden = !this.session.caps?.includes('fps60');
    for (const r of document.querySelectorAll('#qualityGroup input')) this._on(r, 'change', () => { if (r.checked) this._setQuality(r.value); });

    on('optSound', 'change', e => this._setMuted(!e.target.checked));
    // This device's volume (phones and tablets set it with their own buttons).
    on('optVolume', 'input', e => {
      const vol = Number(e.target.value);
      try { this.video.volume = vol; } catch {}
      this.prefs.set('volume', vol);
      if (vol > 0 && this.video.muted) this._setMuted(false);
      this.$('optVolumeOut').textContent = `${Math.round(vol * 100)}%`;
    });

    // Capture: its speed, and capturing on a click.
    $('captureClickWrap').hidden = $('mouseSpeedWrap').hidden = !this.canCapture;
    const speed = $('optMouseSpeed'), speedText = () => { $('mouseSpeedValue').textContent = `${Number(speed.value).toFixed(2).replace(/0$/, '')}×`; };
    speed.value = String(this.prefs.get('mouseSpeed'));
    speedText();
    on('optMouseSpeed', 'input', () => { this.prefs.set('mouseSpeed', Number(speed.value)); speedText(); });
    $('optCaptureClick').checked = !!this.prefs.get('captureOnClick');
    on('optCaptureClick', 'change', e => this.prefs.set('captureOnClick', e.target.checked));

    on('optStats', 'change', e => this._setStats(e.target.checked));

    // "⌘ is Ctrl": on by default on Apple devices, where ⌘ sits where a PC keyboard has Ctrl.
    $('twKeys').hidden = this.guest;
    $('optSwap').checked = !!this.prefs.get('swapCtrlCmd');
    on('optSwap', 'change', e => this._setSwap(e.target.checked));
    on('optZoom', 'click', () => { this.setView(IDENTITY); this._closeOverlays({ focus: true }); });
    // Task Manager (Ctrl+Shift+Esc: Ctrl+Alt+Del can't be pressed by a program) and closing the app in front.
    on('optForceQuit', 'click', () => this._pressAndClose('taskManager'));
    on('optCloseApp', 'click', () => this._pressAndClose('closeApp'));
    // Touchpad mode, on phones and tablets.
    $('touchpadWrap').hidden = $('touchpadHelp').hidden = !this.touchFirst || this.guest;
    $('optTouchpad').checked = !!this.prefs.get('touchpad');
    on('optTouchpad', 'change', e => this._setTouchpad(e.target.checked));
    this.root.classList.toggle('touchpad', this.touchFirst && !!this.prefs.get('touchpad'));
    $('twMouse').hidden = this.guest;

    // Clipboard text both ways, on PCs that offer it.
    const canClip = !this.guest && !!this.session.caps?.includes('clipboard');
    this.canClip = canClip;
    $('twClip').hidden = !canClip;
    $('optPaste').hidden = $('optCopy').hidden = !canClip;
    // Pictures, Ctrl+V without the box, and copies on the PC coming here by themselves, on PCs that offer them.
    this.clipImg = canClip && !!this.session.caps?.includes('clipimg');
    $('clipSyncWrap').hidden = !this.clipImg;
    $('optClipSync').checked = !!this.prefs.get('clipSync');
    if (this.clipImg && this.prefs.get('clipSync')) this.session.send({ t: 'clip-sync', on: true });
    on('optClipSync', 'change', e => this._setClipSync(e.target.checked));
    on('optPaste', 'click', () => this._pasteToPc());
    on('optCopy', 'click', () => this._copyFromPc());
    on('clipGo', 'click', () => this._sendClip($('clipText').value, true));
    on('clipOnly', 'click', () => this._sendClip($('clipText').value, false));
    on('clipClose', 'click', () => this._closeClip());
    this._on($('clipSheet'), 'keydown', e => { if (e.key === 'Escape') { e.preventDefault(); this._closeClip(); } });

    // Sound levels, set on the PC: what is sent here (0–150%) and its own speakers (0–100%, 0 = silent). Sent while
    // a slider moves (at most a few times a second) and once more when it's let go; the PC's status echoes them back.
    this._showLevels(this.ready.levels);
    const sendLevels = (final) => {
      const now = performance.now();
      if (!final && now - (this.levelsSentAt ?? 0) < 150) return;
      this.levelsSentAt = now;
      this.session.send({ t: 'levels', stream: Number($('optStream').value) / 100, speakers: Number($('optSpeakers').value) / 100 });
    };
    for (const id of ['optStream', 'optSpeakers']) {
      on(id, 'input', () => { this._levelText(); sendLevels(false); });
      on(id, 'change', () => { this.levelsDragged = performance.now(); sendLevels(true); });
    }

    // Talking through the PC, where the PC, the browser and the connection all can.
    this.micOn = false;
    $('optMic').hidden = this.guest || !this.session.canMic;
    on('optMic', 'click', () => this._toggleMic());
    this.session.onmicended = () => {
      if (!this.micOn) return;
      this._micOff();
      this.session.send({ t: 'mic', on: false });
    };
    // One window at a time, on PCs that offer it.
    this.canWindow = !this.guest && !!this.session.caps?.includes('window');
    $('windowWrap').hidden = !this.canWindow;
    $('optFit').hidden = true;
    this.windowId = null;
    this._setWindows([]);
    on('optWindow', 'change', e => this._chooseWindow(e.target.value));
    on('optFit', 'click', () => this._fitWindow());
    $('optKeyframe').hidden = this.guest;
    on('optKeyframe', 'click', () => this._refresh());
  }

  _refresh() {
    this.session.send({ t: 'keyframe' });
    this._closeOverlays({ focus: true });
  }

  _pressAndClose(id) {
    this._closeOverlays({ focus: true });
    if (!this.inputAllowed) return;
    this.keys._press(findShortcut(id, this.customKeys));
  }

  _setSwap(on) {
    this.keys.releaseAll();
    this.prefs.set('swapCtrlCmd', on);
    this.$('optSwap').checked = on;
  }

  _setTouchpad(on) {
    this.prefs.set('touchpad', on);
    this.$('optTouchpad').checked = on;
    this.root.classList.toggle('touchpad', on);
  }

  _setClipSync(on) {
    this.prefs.set('clipSync', on);
    this.$('optClipSync').checked = on;
    this.session.send({ t: 'clip-sync', on });
  }

  _toggleTweaks(open) {
    const panel = this.$('tweaks');
    const show = open ?? panel.hidden;
    if (show === !panel.hidden) return;
    if (show) {
      this._closeOverlays({ except: 'tweaks' });
      this.root.classList.toggle('tweaks-left', onRight(this._at()));
      panel.hidden = false;
      this._askWindows();
      this._scrim();
      this.$('tweaksClose').focus({ preventScroll: true });
    } else {
      panel.hidden = true;
      this._scrim();
      if (panel.contains(document.activeElement) || document.activeElement === document.body) this.surface.focus({ preventScroll: true });
    }
    this.$('dkTweaks').setAttribute('aria-expanded', String(show));
    this._showDock();
  }

  // Opens Tweaks at one of its sections (from the Command palette).
  _tweaksAt(id) {
    this._toggleTweaks(true);
    const el = this.$(id);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el?.querySelector('input, select, button')?.focus({ preventScroll: true });
  }

  // The scrim behind a panel: on phones for Tweaks and the Key deck chooser (they come up from the bottom), always
  // for the Command palette.
  _scrim() {
    const phone = window.matchMedia('(max-width: 640px)').matches;
    const show = !this.$('palette').hidden || (phone && (!this.$('tweaks').hidden || !this.$('keysEditor').hidden));
    this.$('scrim').hidden = !show;
  }

  // Closes the palette, Tweaks, the display map and the Key deck chooser (all but `except`).
  _closeOverlays({ except = null, focus = false } = {}) {
    if (except !== 'palette' && this.palette?.open) this.palette.hide();
    if (except !== 'tweaks' && !this.$('tweaks').hidden) {
      this.$('tweaks').hidden = true;
      this.$('dkTweaks').setAttribute('aria-expanded', 'false');
    }
    if (except !== 'map') this._toggleDisplayMap(false);
    if (except !== 'keys') this._closeKeysEditor({ focus: false });
    this._scrim();
    if (focus) this.surface.focus({ preventScroll: true });
  }

  // The sound sliders, from the PC's own levels (ready, then status). Only the owner's viewer, and only where the PC
  // knows about them; the speakers slider only where the PC can keep its speakers quiet.
  _showLevels(levels) {
    const wrap = this.$('levelsWrap');
    const ok = !this.guest && !!levels && this.session.caps?.includes('levels');
    wrap.hidden = !ok;
    if (!ok) return;
    // Just let go of: the PC's echo of the previous value mustn't pull the slider back.
    const settling = performance.now() - (this.levelsDragged ?? -Infinity) < 600;
    const active = document.activeElement;
    if (typeof levels.stream === 'number' && !settling && active !== this.$('optStream')) this.$('optStream').value = String(Math.round(levels.stream * 100));
    if (typeof levels.speakers === 'number' && !settling && active !== this.$('optSpeakers')) this.$('optSpeakers').value = String(Math.round(levels.speakers * 100));
    this.$('optSpeakers').disabled = levels.speakersAvailable !== true;
    this.$('speakersNote').hidden = levels.speakersAvailable === true;
    this.$('speakersHelp').hidden = levels.speakersAvailable !== true;
    this._levelText();
  }

  _levelText() {
    this.$('optStreamOut').textContent = `${this.$('optStream').value}%`;
    this.$('optSpeakersOut').textContent = Number(this.$('optSpeakers').value) === 0 ? 'Silent' : `${this.$('optSpeakers').value}%`;
  }

  // --- the Command palette: every action, searchable ---

  _wirePalette() {
    this.palette = new Palette({
      root: this.$('palette'), input: this.$('paletteInput'), list: this.$('paletteList'), empty: this.$('paletteEmpty'),
      actions: () => this._actions(),
      // On a phone the search box would bring up the keyboard over the list: the list comes first there.
      focusInput: () => !this.touchFirst,
      onClose: () => {
        this.$('dkPalette').setAttribute('aria-expanded', 'false');
        this._scrim();
        const a = document.activeElement;
        if (!a || a === document.body || this.$('palette').contains(a)) this.surface.focus({ preventScroll: true });
      },
    });
  }

  _togglePalette(open) {
    const show = open ?? !this.palette.open;
    if (show === this.palette.open) return;
    if (show) {
      this._closeOverlays({ except: 'palette' });
      this._askWindows();
      this.palette.show();
      this.$('dkPalette').setAttribute('aria-expanded', 'true');
      this._scrim();
    } else {
      this.palette.hide();
    }
    this._showDock();
  }

  // Everything the viewer can do, for the Command palette. Kept as one list so nothing is only reachable one way.
  _actions() {
    const owner = !this.guest, input = () => this.inputAllowed && !this.over;
    const A = [];
    const add = (group, a) => A.push({ group, ...a });
    const video = this.video;

    // Picture
    for (const q of Object.keys(QUALITY_TEXT)) {
      if (!owner || (q === 'fast' && !this.session.caps?.includes('fps60'))) continue;
      add('Picture', { id: `quality-${q}`, icon: q === 'fast' ? 'bolt' : 'display', label: `Quality: ${QUALITY_TEXT[q][0]}`,
        hint: QUALITY_TEXT[q][1], keywords: 'quality picture resolution fps frames blurry sharp', state: () => (this.quality === q ? 'Now' : null),
        run: () => this._setQuality(q) });
    }
    for (const s of SHAPES) {
      add('Picture', { id: `shape-${s}`, icon: 'fullscreen', label: `Shape: ${SHAPE_TEXT[s]}`, keywords: 'fit fill stretch aspect bars crop',
        state: () => (this._shape() === s ? 'Now' : null), run: () => this._setShape(s) });
    }
    if (this.canWindow) {
      add('Picture', { id: 'window-whole', icon: 'display', label: 'Show the whole screen', keywords: 'window desktop all',
        state: () => (this.windowId == null ? 'Now' : null), run: () => this._chooseWindow(null) });
      for (const w of this.windows) {
        add('Picture', { id: `window-${w.id}`, icon: 'window', label: `Show only ${w.name}`, keywords: 'one window app single',
          state: () => (this.windowId === w.id ? 'Now' : null), run: () => this._chooseWindow(String(w.id)) });
      }
      add('Picture', { id: 'window-fit', icon: 'fullscreen', label: 'Fit this window to my screen', keywords: 'resize reshape window',
        when: () => this.windowId != null, run: () => this._fitWindow() });
    }
    add('Picture', { id: 'zoom-out', icon: 'zoom', label: 'Zoom back out', keywords: 'zoom reset pinch', when: () => isZoomed(this.view),
      run: () => this.setView(IDENTITY) });
    if (owner) add('Picture', { id: 'keyframe', icon: 'refresh', label: 'Refresh the picture', keywords: 'redraw glitch keyframe', run: () => this._refresh() });
    if (!this.$('dkFull').hidden) {
      add('Picture', { id: 'fullscreen', icon: 'fullscreen', label: 'Full screen', keywords: 'fullscreen maximise',
        state: () => !!(document.fullscreenElement || document.webkitFullscreenElement), run: () => this._toggleFullscreen() });
    }

    // Displays
    if (owner && (this.displays ?? []).length > 1) {
      this.displays.forEach((d, i) => add('Displays', { id: `display-${d.id}`, icon: 'display',
        label: `Show display ${i + 1}${d.name ? `: ${d.name}` : ''}`, hint: d.main ? 'Main display' : `${d.width} × ${d.height}`,
        keywords: 'monitor screen switch', state: () => (this.display.id === d.id ? 'Now' : null), run: () => this._showDisplay(d.id) }));
      add('Displays', { id: 'display-map', icon: 'displays', label: 'Displays, as arranged', keywords: 'map monitors layout',
        run: () => this._toggleDisplayMap(true) });
    }

    // Keyboard
    if (owner) {
      if (this.touchFirst) {
        add('Keyboard', { id: 'soft-keyboard', icon: 'keyboard', label: 'Show the keyboard', keywords: 'type text phone',
          run: () => this.keys.showSoftKeyboard() });
      }
      add('Keyboard', { id: 'deck', icon: 'keys', label: 'Key deck', hint: 'Win, Ctrl, Alt, shortcuts', keywords: 'keys bar special modifiers',
        state: () => !this.$('keysBar').hidden, run: () => this._setDeck(this.$('keysBar').hidden) });
      add('Keyboard', { id: 'deck-edit', icon: 'plus', label: 'Choose the Key deck’s keys', keywords: 'customise edit add shortcut',
        run: () => this._openKeysEditor() });
      add('Keyboard', { id: 'swap', icon: 'keyboard', label: '⌘ is Ctrl', hint: 'For Mac keyboards', keywords: 'command cmd control swap apple mac',
        state: () => !!this.prefs.get('swapCtrlCmd'), run: () => this._setSwap(!this.prefs.get('swapCtrlCmd')) });
      for (const [k, s] of Object.entries(SWIPE_ACTIONS)) {
        add('Keyboard', { id: `swipe-${k}`, icon: 'touch', label: `Swipe sideways: ${s.label}`, keywords: 'gesture touchpad three fingers',
          state: () => (this.prefs.get('swipe') === k ? 'Now' : null), run: () => { this.prefs.set('swipe', k); this.$('optSwipe').value = k; } });
      }
      // Every key and shortcut the Key deck knows, ready to press.
      for (const s of [...CATALOG, ...this.customKeys]) {
        add('Press a key', { id: `press-${s.id}`, icon: s.sys ? 'display' : 'keys', label: `Press ${s.title}`,
          hint: s.title.includes(s.label) ? '' : s.label, keywords: `${s.group} key shortcut ${s.label}`,
          disabled: () => !input(), run: () => { this.surface.focus({ preventScroll: true }); if (input()) this.keys._press(s); } });
      }
    }

    // Clipboard
    if (this.canClip) {
      add('Clipboard', { id: 'paste', icon: 'paste', label: 'Paste on the PC', hint: 'This device’s clipboard', keywords: 'clipboard send text picture',
        run: () => this._pasteToPc() });
      add('Clipboard', { id: 'copy', icon: 'copy', label: 'Copy the PC’s clipboard', hint: 'To this device', keywords: 'clipboard get text',
        run: () => this._copyFromPc() });
      if (this.clipImg) {
        add('Clipboard', { id: 'clip-sync', icon: 'clipboard', label: 'Share the clipboard both ways', keywords: 'sync automatic copy paste',
          state: () => !!this.prefs.get('clipSync'), run: () => this._setClipSync(!this.prefs.get('clipSync')) });
      }
    }

    // Sound
    if (this.ready.audio !== false) {
      add('Sound', { id: 'mute', icon: video.muted ? 'muted' : 'sound', label: video.muted ? 'Turn sound on' : 'Mute', keywords: 'sound audio volume mute',
        run: () => this._setMuted(!video.muted) });
    }
    add('Sound', { id: 'levels', icon: 'sliders', label: 'Sound levels', hint: 'This device, the PC’s speakers', keywords: 'volume speakers silent',
      run: () => this._tweaksAt('twSound') });
    if (owner && this.session.canMic) {
      add('Sound', { id: 'mic', icon: 'mic', label: 'Talk through your PC', keywords: 'microphone voice call',
        state: () => !!this.micOn, run: () => this._toggleMic() });
    }

    // Mouse and touch
    if (this.canCapture) {
      add('Mouse and touch', { id: 'capture', icon: 'pointer', label: 'Capture the mouse', hint: 'Esc lets go', keywords: 'pointer lock games',
        run: () => this._capture() });
      add('Mouse and touch', { id: 'capture-click', icon: 'pointer', label: 'Capture the mouse when I click', keywords: 'pointer lock',
        state: () => !!this.prefs.get('captureOnClick'), run: () => { const v = !this.prefs.get('captureOnClick'); this.prefs.set('captureOnClick', v); this.$('optCaptureClick').checked = v; } });
      add('Mouse and touch', { id: 'mouse-speed', icon: 'sliders', label: 'Captured mouse speed', keywords: 'sensitivity pointer',
        hint: `${this.prefs.get('mouseSpeed')}×`, run: () => this._tweaksAt('mouseSpeedWrap') });
    }
    if (owner && !this.touchFirst) {
      add('Mouse and touch', { id: 'hide-cursor', icon: 'pointer', label: 'Hide this computer’s pointer', hint: 'Esc twice brings it back',
        keywords: 'cursor', state: () => !!this.prefs.get('hideCursor'), run: () => this._setHideCursor(!this.prefs.get('hideCursor')) });
    }
    if (owner && this.touchFirst) {
      add('Mouse and touch', { id: 'touchpad', icon: 'touch', label: 'Touchpad mode', hint: 'Your finger moves the pointer', keywords: 'trackpad',
        state: () => !!this.prefs.get('touchpad'), run: () => this._setTouchpad(!this.prefs.get('touchpad')) });
    }

    // The Dock
    for (const at of ANCHORS) {
      add('The Dock', { id: `dock-${at}`, icon: 'dock', label: `Move the Dock to the ${ANCHOR_TEXT[at]}`, keywords: 'position place edge corner',
        state: () => (this._at() === at ? 'Now' : null), run: () => this._moveDock(at) });
    }
    add('The Dock', { id: 'dock-orb', icon: 'orb', label: 'Shrink the Dock to an orb', keywords: 'collapse hide minimise', run: () => this._toOrb() });
    for (const [k, t] of Object.entries(IDLE_TEXT)) {
      add('The Dock', { id: `dock-idle-${k}`, icon: 'dock', label: `When I'm not using it: ${t}`, keywords: 'auto hide idle',
        state: () => (this._idleMode() === k ? 'Now' : null), run: () => this._setIdle(k) });
    }
    add('The Dock', { id: 'dock-room', icon: 'dock', label: 'Keep the picture clear of the Dock', keywords: 'room space strip',
      when: () => this._idleMode() === 'stay', state: () => this._room(), run: () => this._setRoom(!this._room()) });
    add('The Dock', { id: 'tweaks', icon: 'sliders', label: 'Open Tweaks', keywords: 'settings preferences options', run: () => this._toggleTweaks(true) });

    // The session
    add('Session', { id: 'stats', icon: 'stats', label: 'Connection details', keywords: 'stats ping latency fps bitrate',
      state: () => !this.$('stats').hidden, run: () => this._setStats(this.$('stats').hidden) });
    if (owner) add('Session', { id: 'task-manager', icon: 'warn', label: 'Open Task Manager', hint: 'Ctrl+Shift+Esc', keywords: 'force quit kill frozen ctrl alt del',
      disabled: () => !input(), run: () => this._pressAndClose('taskManager') });
    add('Session', { id: 'disconnect', icon: 'power', label: 'Disconnect', keywords: 'leave end quit bye', run: () => this.onLeave() });
    return A;
  }

  // The display picker. Called again when the PC says its displays changed (one was unplugged or plugged in).
  _setDisplays(displays, shownId) {
    const ids = (list) => (list ?? []).map(d => `${d.id}:${d.x},${d.y},${d.width},${d.height}`).join(' ');
    if (ids(displays) !== ids(this.displays)) this.edgeFlip?.reset();
    this.displays = displays;
    const shown = displays.find(d => d.id === shownId) ?? displays[0];
    if (shown && this.display.id !== shown.id) {
      this.display = { id: shown.id, width: shown.width, height: shown.height };
      this.setView(IDENTITY);
    }
    // A guest can't switch displays (the PC ignores it), so they aren't offered the picker.
    this.$('dkDisplay').hidden = displays.length < 2 || !!this.guest;
    if (displays.length < 2) this._toggleDisplayMap(false);
    this._renderDisplayPicker();
  }

  _shownDisplay() { return (this.displays ?? []).find(d => d.id === this.display.id) ?? null; }

  // One button per display, numbered, each with a small outline in its own shape; and the map, when it is open.
  _renderDisplayPicker() {
    const list = this.displays ?? [];
    const index = list.findIndex(d => d.id === this.display.id);
    this.$('dkDisplayNum').textContent = String(index + 1 || 1);
    this.$('dkDisplay').setAttribute('aria-label', `Displays (showing ${index + 1 || 1} of ${list.length})`);
    // Only when something changed: rebuilding would take keyboard focus off a button.
    const key = `${this.display.id}|${list.map(d => `${d.id}:${d.name}:${d.width}x${d.height}:${d.main}`).join(',')}`;
    if (key === this.pickerKey) { if (!this.$('displayMap').hidden) this._renderDisplayMap(); return; }
    this.pickerKey = key;
    const biggest = Math.max(1, ...list.map(d => Math.max(d.width || 0, d.height || 0)));
    const chips = list.map((d, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'display-chip';
      b.title = d.name || `Display ${i + 1}`;
      b.setAttribute('aria-label', `${d.name || `Display ${i + 1}`}${d.main ? ' (main display)' : ''}`);
      b.setAttribute('aria-pressed', String(d.id === this.display.id));
      const shape = document.createElement('span');
      shape.className = 'shape';
      // A wider display draws a wider outline; the largest is 18 px across.
      const k = 18 / biggest;
      shape.style.width = `${Math.max(8, Math.round((d.width || biggest) * k))}px`;
      shape.style.height = `${Math.max(6, Math.round((d.height || biggest * 0.6) * k))}px`;
      b.append(shape, String(i + 1));
      b.addEventListener('click', () => this._showDisplay(d.id)); // replaced with the button, so not in this.listeners
      return b;
    });
    const box = this.$('dkDisplays');
    const focused = [...box.children].indexOf(document.activeElement);
    box.replaceChildren(...chips);
    if (focused >= 0) chips[focused]?.focus();
    if (!this.$('displayMap').hidden) this._renderDisplayMap();
  }

  _renderDisplayMap() {
    const area = this.$('displayMapArea');
    const all = arrangement(this.displays ?? []);
    if (!all.length) { area.replaceChildren(); return; }
    const minX = Math.min(...all.map(d => d.x)), minY = Math.min(...all.map(d => d.y));
    const spanX = Math.max(...all.map(d => d.x + d.width)) - minX, spanY = Math.max(...all.map(d => d.y + d.height)) - minY;
    const boxW = area.clientWidth || 260, boxH = (area.clientHeight || 128) - 12;
    const k = Math.min((boxW - 12) / (spanX || 1), boxH / (spanY || 1));
    const offX = (boxW - spanX * k) / 2, offY = 6 + (boxH - spanY * k) / 2;
    area.replaceChildren(...all.map((d, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `map-display${d.id === this.display.id ? ' on' : ''}${d.main ? ' main' : ''}`;
      b.setAttribute('aria-pressed', String(d.id === this.display.id));
      b.title = `${d.name || `Display ${i + 1}`}${d.main ? ' (main display)' : ''}`;
      b.textContent = `${i + 1}`;
      Object.assign(b.style, {
        left: `${offX + (d.x - minX) * k + 2}px`, top: `${offY + (d.y - minY) * k + 2}px`,
        width: `${Math.max(14, d.width * k - 4)}px`, height: `${Math.max(12, d.height * k - 4)}px`,
      });
      b.addEventListener('click', () => { this._showDisplay(d.id); this.$('dkDisplay').focus(); });
      return b;
    }));
  }

  _toggleDisplayMap(open) {
    const map = this.$('displayMap');
    const show = (open ?? map.hidden) && (this.displays ?? []).length > 1 && !this.guest;
    if (show === !map.hidden) return;
    map.hidden = !show;
    this.$('dkDisplay').setAttribute('aria-expanded', String(show));
    if (show) {
      this._closeOverlays({ except: 'map' });
      if (this.root.classList.contains('dock-orb') || this.root.classList.contains('dock-away')) this._fromOrb();
      this._showDock();
      this._placePops();
      this._renderDisplayMap();
    }
  }

  // Popovers open beside the Dock button they belong to, on the side facing the middle of the screen.
  _placePops() {
    const map = this.$('displayMap');
    if (map.hidden) return;
    const b = this.$('dkDisplay').getBoundingClientRect(), r = this.root.getBoundingClientRect();
    const w = map.offsetWidth, h = map.offsetHeight, gap = 10, pad = 12;
    const clamp = (v, lo, hi) => Math.min(Math.max(lo, v), Math.max(lo, hi));
    let x, y;
    if (isVertical(this._at())) {
      x = this._at() === 'left' ? b.right + gap : b.left - gap - w;
      y = clamp(b.top + b.height / 2 - h / 2 - r.top, pad, r.height - h - pad);
      x -= r.left;
    } else {
      x = clamp(b.left + b.width / 2 - w / 2 - r.left, pad, r.width - w - pad);
      y = anchorEdge(this._at()) === 'top' ? b.bottom + gap - r.top : b.top - gap - h - r.top;
    }
    Object.assign(map.style, { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` });
  }

  // Show another of the PC's displays.
  _showDisplay(id) {
    const d = (this.displays ?? []).find(x => x.id === id);
    if (!d || this.guest || d.id === this.display.id) return;
    this.display = { id: d.id, width: d.width, height: d.height };
    this._showWindow(null); // a window chosen on the other display doesn't carry over
    this.session.send({ t: 'display', id: d.id });
    this.setView(IDENTITY);
    this._renderDisplayPicker();
  }

  // The edge flip (displays.js): the pointer waiting at an edge of the picture shows which display is beyond it, and
  // after EDGE_DWELL_MS (or a captured mouse pushed on past the edge) the view moves there. A captured mouse then comes
  // in at the facing edge of the new display; an uncaptured one stays where the page's pointer is.
  _edge(p, push, locked) {
    clearTimeout(this.edgeTimer);
    if (!this.edgeFlip) return null;
    if (!p) { this.edgeFlip.reset(); this._edgeHint(null); return null; }
    const r = this.edgeFlip.move(p, performance.now(), push);
    if (r?.flip) return this._edgeFlip(r.flip);
    this._edgeHint(r?.hint ?? null);
    if (r?.hint) {
      const wait = Math.max(0, EDGE_DWELL_MS - (performance.now() - r.hint.since)) + 10;
      this.edgeTimer = setTimeout(() => {
        const t = this.edgeFlip.tick(performance.now());
        if (t?.flip) {
          const across = this._edgeFlip(t.flip);
          if (across && this.pointer?.locked) this.pointer.last = across;
        }
      }, wait);
    }
    return null;
  }

  _edgeFlip(f) {
    this._edgeHint(null);
    const from = this._shownDisplay();
    this._showDisplay(f.target.id);
    return from ? entryPoint(this.displays, from, f.target, f.edge, f.along) : null;
  }

  _edgeHint(hint) {
    const el = this.$('edgeHint');
    if (!hint) { el.hidden = true; this.edgeHintKey = null; return; }
    const key = `${hint.edge}:${hint.target.id}:${hint.since}`;
    if (key === this.edgeHintKey) return;
    this.edgeHintKey = key;
    const name = hint.target.name || 'the next display';
    const arrow = { right: '→', left: '←', top: '↑', bottom: '↓' }[hint.edge];
    this.$('edgeHintText').textContent = hint.edge === 'left' || hint.edge === 'top' ? `${arrow} ${name}` : `${name} ${arrow}`;
    el.className = `edge-hint at-${hint.edge}`;
    el.hidden = false;
    void el.offsetWidth; // start the fill from empty
    el.classList.add('charging');
  }

  // Tells the PC how big its picture is on this screen, in real pixels, so it doesn't send more than can be shown
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
      const shown = Math.max(...shownScale(box.width, box.height, vw, vh, this._shape())); // CSS pixels per picture pixel
      const zoom = Math.min(2, Math.max(1, this.view.scale ?? 1));
      const edge = Math.round(Math.max(vw, vh) * shown * (window.devicePixelRatio || 1) * zoom);
      if (this.lastViewEdge && Math.abs(edge - this.lastViewEdge) < this.lastViewEdge * 0.08) return;
      this.lastViewEdge = edge;
      this.session.send({ t: 'view', edge });
    }, 600);
  }

  _setQuality(preset) {
    if (!(preset in QUALITY)) return;
    this._showQuality(preset);
    this.prefs.set('quality', preset);
    this.session.send({ t: 'quality', preset });
    if (this.status.link === 'slow') this._applyStatus({ link: 'slow' });
  }

  _showQuality(preset) {
    this.quality = preset;
    for (const r of document.querySelectorAll('#qualityGroup input')) r.checked = r.value === preset;
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
    this._closeOverlays();
    this.surface.focus({ preventScroll: true });
    // Raw mouse movement (no acceleration) where the browser offers it, as games want.
    try {
      await this.surface.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try { await this.surface.requestPointerLock(); } catch { /* pointerlockerror says so */ }
    }
  }

  // --- the picture's shape on this screen: whole (bars where the shapes differ), filling it, or stretched ---

  _shape() { return SHAPES.includes(this.prefs.get('shape')) ? this.prefs.get('shape') : 'fit'; }

  _wireShape() {
    this.pan = { ...CENTER };
    for (const r of document.querySelectorAll('#shapeGroup input')) this._on(r, 'change', () => { if (r.checked) this._setShape(r.value); });
    this._applyShape();
  }

  _setShape(shape) {
    this.prefs.set('shape', SHAPES.includes(shape) ? shape : 'fit');
    this._applyShape();
  }

  _applyShape() {
    const shape = this._shape();
    for (const s of SHAPES) this.root.classList.toggle(`shape-${s}`, s === shape);
    for (const r of document.querySelectorAll('#shapeGroup input')) r.checked = r.value === shape;
    this._setPan(this.pan ?? CENTER);
    this._shapeUi();
    this.lastViewEdge = 0;
    this._reportView();
  }

  // Where a "fill" picture has slid to: 0..1 each way, as CSS's object-position percentages.
  _setPan(p) {
    const x = Math.min(1, Math.max(0, Number(p?.x ?? 0.5))), y = Math.min(1, Math.max(0, Number(p?.y ?? 0.5)));
    this.pan = { x, y };
    this.video.style.objectPosition = this._shape() === 'fill' ? `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%` : '';
  }

  // Says how much a "fill" picture leaves out, or how much "stretch" squeezes, for this window and this PC.
  _shapeUi() {
    const note = this.$('shapeHelp');
    const box = this.surface.getBoundingClientRect();
    const v = this.video, vw = v.videoWidth, vh = v.videoHeight;
    const shape = this._shape();
    if (!(vw > 0 && vh > 0 && box.width > 0 && box.height > 0)) { note.hidden = true; return; }
    const ratio = (box.width / box.height) / (vw / vh);
    const off = Math.round(Math.abs(1 - Math.min(ratio, 1 / ratio)) * 100);
    note.hidden = false;
    note.textContent = off < 2 ? 'This screen and the PC’s are the same shape.'
      : shape === 'fill' ? `About ${off}% of the PC’s screen is off the ${ratio < 1 ? 'sides' : 'top and bottom'}: the picture slides along as the pointer nears an edge${this.touchFirst ? ' (or drag it with two fingers)' : ''}.`
        : shape === 'stretch' ? `The picture is squeezed by about ${off}% to fit this screen.`
          : 'The whole of the PC’s screen, with bars where the shapes differ.';
  }

  // --- where the Dock sits, and what it does when not in use ---

  _at() { return this.prefs.get('dockAt') ?? (this.touchFirst ? 'bottom' : 'top'); }
  _idleMode() { return this.prefs.get('dockIdle') ?? (this.touchFirst ? 'orb' : 'stay'); }
  _room() { const r = this.prefs.get('dockRoom'); return typeof r === 'boolean' ? r : !this.touchFirst; }

  _wirePlacement() {
    const $ = this.$, prefs = this.prefs;
    $('optDockIdle').value = this._idleMode();
    $('optDockRoom').checked = this._room();
    this._on($('optDockIdle'), 'change', e => this._setIdle(e.target.value));
    this._on($('optDockRoom'), 'change', e => this._setRoom(e.target.checked));
    for (const b of $('dockPos').querySelectorAll('button')) this._on(b, 'click', () => this._moveDock(b.dataset.at));
    // The arrow keys move the radio group's choice, as radio buttons do.
    this._on($('dockPos'), 'keydown', e => {
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!step) return;
      e.preventDefault();
      this._moveDock(stepAnchor(this._at(), ...step));
      $('dockPos').querySelector(`[data-at="${this._at()}"]`)?.focus();
    });

    // Drag the grip (or the orb): the Dock follows the finger, then snaps to the nearest edge or corner.
    const startDrag = (el, e) => {
      if (e.button !== 0) return;
      this.drag = { el, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      try { el.setPointerCapture(e.pointerId); } catch {}
    };
    this._on($('dockGrip'), 'pointerdown', e => startDrag($('dock'), e));
    this._on($('orb'), 'pointerdown', e => { this.orbDragged = false; startDrag($('orb'), e); });
    this._on(window, 'pointermove', e => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
      if (!d.moved) { d.moved = true; this.root.classList.add('dragging'); this._closeOverlays(); }
      e.preventDefault();
      d.el.style.transform = `translate(${dx}px, ${dy}px)`;
      // Where it would land, shown live on the position grid in Tweaks.
      const box = this.root.getBoundingClientRect();
      this.dropAt = nearestAnchor(e.clientX - box.left, e.clientY - box.top, box.width, box.height);
    });
    const drop = e => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      this.drag = null;
      if (!d.moved) return;
      if (d.el.id === 'orb') { this.orbDragged = true; setTimeout(() => { this.orbDragged = false; }, 0); }
      this.root.classList.remove('dragging');
      this._moveDock(this.dropAt ?? this._at(), { from: d.el });
    };
    this._on(window, 'pointerup', drop, true);
    this._on(window, 'pointercancel', drop, true);
    // From the keyboard: the arrow keys move it to the next place that way.
    this._on($('dockGrip'), 'keydown', e => {
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!step) return;
      e.preventDefault();
      this._moveDock(stepAnchor(this._at(), ...step));
      $('dockGrip').focus({ preventScroll: true });
    });

    // The Dock, the Key deck and the window changing size all move things about.
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(this.placeFrame);
        this.placeFrame = requestAnimationFrame(() => this._placeDock());
      });
      for (const id of ['dock', 'keysBar', 'viewer']) this.resizeObserver.observe($(id));
    }
    this.root.classList.add('no-anim');
    if (prefs.get('dockOrb')) this.root.classList.add('dock-orb');
    this._placeDock();
    requestAnimationFrame(() => this.root.classList.remove('no-anim'));
  }

  // Moves the Dock to one of the eight places. `from`: the element as it was dropped, which then glides into place.
  _moveDock(at, { from = null } = {}) {
    if (!ANCHORS.includes(at)) return;
    const el = from ?? (this.root.classList.contains('dock-orb') ? this.$('orb') : this.$('dock'));
    const first = el.getBoundingClientRect();
    this.prefs.set('dockAt', at);
    el.style.transform = '';
    this.root.classList.add('no-anim');
    this._placeDock();
    // FLIP: start where it was, then let it glide to its new place.
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left, dy = first.top - last.top;
    if ((dx || dy) && !matchMedia('(prefers-reduced-motion: reduce)').matches && !el.hidden) {
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      void el.offsetWidth;
      this.root.classList.remove('no-anim');
      el.style.transform = '';
    } else {
      this.root.classList.remove('no-anim');
    }
    this._showDock();
    this._placePops();
  }

  _setIdle(mode) {
    if (!(mode in IDLE_TEXT)) return;
    this.prefs.set('dockIdle', mode);
    this.prefs.set('dockOrb', false);
    this.$('optDockIdle').value = mode;
    this.root.classList.remove('dock-orb', 'dock-away');
    this._placeDock();
    this._showDock();
    if (mode !== 'stay' && !this.prefs.get('dockNoted')) {
      this.prefs.set('dockNoted', true);
      this.banners.show('dockhide', { kind: 'info', icon: 'dock',
        title: mode === 'orb' ? 'The Dock shrinks to an orb when you’re not using it.' : 'The Dock tucks itself away when you’re not using it.',
        body: mode === 'orb' ? 'Tap the orb to bring it back.' : this.touchFirst ? 'Tap the small tab at the edge to bring it back.'
          : 'Move the pointer to the very edge of the window to bring it back.', dismissible: true });
      clearTimeout(this.hideNoteTimer);
      this.hideNoteTimer = setTimeout(() => this.banners.hide('dockhide'), 6000);
    }
  }

  _setRoom(on) {
    this.prefs.set('dockRoom', on);
    this.$('optDockRoom').checked = on;
    this._placeDock();
  }

  // Shrink the Dock to the orb by hand (it stays an orb until tapped, whatever it does when idle).
  _toOrb() {
    const hadFocus = this.$('dock').contains(document.activeElement);
    this._closeOverlays();
    this.prefs.set('dockOrb', true);
    this.root.classList.remove('dock-away');
    this.root.classList.add('dock-orb');
    this._placeDock();
    // Keyboard users keep their place: on the orb, which opens the Dock again.
    if (hadFocus) this.$('orb').focus({ preventScroll: true });
  }

  _fromOrb() {
    this.prefs.set('dockOrb', false);
    this.root.classList.remove('dock-orb', 'dock-away');
    this._placeDock();
    this._showDock();
  }

  _placeDock() {
    if (!this.root || this.root.hidden) return;
    const root = this.root, $ = this.$, at = this._at();
    for (const a of ANCHORS) root.classList.toggle(`at-${a}`, a === at);
    const vertical = isVertical(at);
    root.classList.toggle('dock-vertical', vertical);
    $('dock').setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
    const orb = root.classList.contains('dock-orb');
    $('orb').hidden = !orb;
    const away = root.classList.contains('dock-away');
    const lip = $('dockLip');
    lip.hidden = !(away && this.touchFirst);
    lip.className = `dock-lip e-${anchorEdge(at)}${at.endsWith('left') && !vertical ? ' p-left' : at.endsWith('right') && !vertical ? ' p-right' : ''}`;
    for (const b of $('dockPos').querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(b.dataset.at === at));
      b.tabIndex = b.dataset.at === at ? 0 : -1;
    }
    $('dockRoomWrap').hidden = this._idleMode() !== 'stay';

    // The Key deck along the bottom: the picture makes room for it with a mouse; things at the bottom sit above it.
    const bar = $('keysBar'), H = root.clientHeight, W = root.clientWidth;
    const deckOn = !bar.hidden;
    root.classList.toggle('deck-on', deckOn);
    const deckUp = deckOn ? Math.max(0, H - bar.offsetTop) : 0;
    root.style.setProperty('--keys-up', `${deckUp}px`);
    root.style.setProperty('--keys-h', `${deckOn && !this.touchFirst ? deckUp : 0}px`);

    // A Dock that stays put can keep the picture clear of it: the picture shrinks to fit beside it rather than under it.
    const dock = $('dock');
    const room = { top: 0, bottom: 0, left: 0, right: 0 };
    if (this._idleMode() === 'stay' && this._room() && !orb && !away) {
      const m = 12, edge = anchorEdge(at);
      if (edge === 'top') room.top = dock.offsetTop + dock.offsetHeight + m;
      else if (edge === 'bottom') room.bottom = Math.max(0, H - dock.offsetTop + m - (deckOn && !this.touchFirst ? deckUp : 0));
      else if (edge === 'left') room.left = dock.offsetLeft + dock.offsetWidth + m;
      else room.right = W - dock.offsetLeft + m;
    }
    for (const [e, v] of Object.entries(room)) root.style.setProperty(`--room-${e}`, `${Math.round(v)}px`);

    const box = this.surface.getBoundingClientRect();
    const key = `${Math.round(box.width)}x${Math.round(box.height)}`;
    if (key !== this.surfaceKey) {
      this.surfaceKey = key;
      this.setView(this.view);
      this._reportView();
    }
  }

  // The Dock is being used: show it, and (if it shrinks or tucks itself away) start counting again.
  _showDock() {
    const root = this.root;
    if (root.classList.contains('dock-away')) { root.classList.remove('dock-away'); this._placeDock(); }
    clearTimeout(this.idleTimer);
    if (this._idleMode() !== 'stay' && !this.prefs.get('dockOrb')) this.idleTimer = setTimeout(() => this._idle(), IDLE_AFTER_MS);
  }

  _idle(now = false) {
    const dock = this.$('dock');
    const busy = !now && (dock.matches(':hover') || dock.contains(document.activeElement) || this.palette?.open ||
      !this.$('tweaks').hidden || !this.$('displayMap').hidden || !!this.drag);
    if (busy) { this.idleTimer = setTimeout(() => this._idle(), IDLE_AFTER_MS); return; }
    const mode = this._idleMode();
    if (mode === 'orb') this.root.classList.add('dock-orb');
    else if (mode === 'hide') this.root.classList.add('dock-away');
    this._placeDock();
  }

  // --- this computer's pointer, hidden so only the PC's shows ---

  _setHideCursor(on, { note = true } = {}) {
    on = on && !this.touchFirst;
    this.prefs.set('hideCursor', on);
    this.$('optHideCursor').checked = on;
    this.root.classList.toggle('nocursor', on);
    if (!note) return;
    this.banners.show('cursor', { kind: 'info', icon: 'pointer',
      title: on ? "This computer's pointer is hidden." : "This computer's pointer is back.",
      body: on ? 'Only your PC’s pointer shows now. Press Esc twice quickly to bring this one back.' : '', dismissible: true });
    clearTimeout(this.cursorNoteTimer);
    this.cursorNoteTimer = setTimeout(() => this.banners.hide('cursor'), 4000);
  }

  // --- swipes ---

  _swipe(dir) {
    if (!this.inputAllowed || this.over) return;
    if (dir === 'up' || dir === 'down') return this._pressId(dir === 'up' ? 'taskView' : 'showDesktop');
    const mode = this.prefs.get('swipe');
    if (mode === 'apps') return this._appSwitch(dir);
    const a = SWIPE_ACTIONS[mode];
    if (a?.next) this._pressId(dir > 0 ? a.next : a.prev);
  }

  _pressId(id) {
    const s = findShortcut(id, this.customKeys);
    if (s) for (const m of pressMessages(s.code, s.key, s.m)) this.session.sendInput(m);
  }

  // Alt stays held between swipes, so the app switcher stays up and each swipe moves along it; let go a moment later.
  _appSwitch(dir) {
    const send = m => this.session.sendInput(m);
    if (!this.altHeld) {
      send({ t: 'k', c: 'AltLeft', k: 'Alt', d: true, m: ALT });
      this.altHeld = true;
    }
    const m = ALT | (dir < 0 ? SHIFT : 0);
    if (dir < 0) send({ t: 'k', c: 'ShiftLeft', k: 'Shift', d: true, m });
    send({ t: 'k', c: 'Tab', k: 'Tab', d: true, m });
    send({ t: 'k', c: 'Tab', k: 'Tab', d: false, m });
    if (dir < 0) send({ t: 'k', c: 'ShiftLeft', k: 'Shift', d: false, m: ALT });
    clearTimeout(this.altTimer);
    this.altTimer = setTimeout(() => this._releaseAlt(), 1000);
  }

  _releaseAlt() {
    clearTimeout(this.altTimer);
    if (!this.altHeld) return;
    this.altHeld = false;
    this.session.sendInput({ t: 'k', c: 'AltLeft', k: 'Alt', d: false, m: 0 });
  }

  // --- the Key deck: which keys it has, and the chooser ---

  _setDeck(on) {
    const bar = this.$('keysBar');
    bar.hidden = !on;
    this.$('dkKeys').setAttribute('aria-pressed', String(on));
    if (!on) this._closeKeysEditor();
    this._placeDock();
  }

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
    $('hideCursorWrap').hidden = $('hideCursorHelp').hidden = !!this.touchFirst || this.guest;
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
      b.className = 'key' + (s.label.length > 3 ? ' wide' : '');
      b.dataset.key = id;
      b.textContent = s.label;
      b.title = s.title;
      if (s.title !== s.label) b.setAttribute('aria-label', s.title);
      return b;
    }));
    if (this.palette?.open) this.palette.render();
  }

  _openKeysEditor() {
    this._closeOverlays({ except: 'keys' });
    this._setDeck(true);
    this._renderKeysEditor();
    this.$('keysEditor').hidden = false;
    this._scrim();
    this.$('keysEditorDone').focus({ preventScroll: true });
  }

  _closeKeysEditor({ focus = true } = {}) {
    const ed = this.$('keysEditor');
    if (ed.hidden) return;
    ed.hidden = true;
    this._scrim();
    if (focus) this.surface.focus({ preventScroll: true });
  }

  _renderKeysEditor() {
    const on = new Set(this.bar);
    const choice = (s, extra) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ke-item';
      b.dataset.id = s.id;
      b.setAttribute('aria-pressed', String(on.has(s.id)));
      const label = document.createElement('b');
      label.textContent = s.label;
      b.append(label);
      if (s.title !== s.label) {
        const t = document.createElement('span');
        t.textContent = s.title;
        b.append(t);
      }
      b.addEventListener('click', e => {
        if (e.target.closest('.ke-x')) return;
        const now = b.getAttribute('aria-pressed') !== 'true';
        this.prefs.set('keysBar', toggleOnBar(this.bar, s.id, now));
        b.setAttribute('aria-pressed', String(now));
        this._renderKeys();
      });
      if (extra) b.append(extra);
      return b;
    };
    const groups = [];
    for (const g of [...GROUPS, 'Yours']) {
      const items = g === 'Yours' ? this.customKeys : CATALOG.filter(s => s.group === g);
      if (!items.length) continue;
      const box = document.createElement('section');
      box.className = 'ke-group';
      const h = document.createElement('h3');
      h.textContent = g === 'Yours' ? 'Your own' : g;
      box.append(h);
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
        h.append(all);
      }
      const chips = document.createElement('div');
      chips.className = 'ke-chips';
      for (const s of items) {
        let extra;
        if (g === 'Yours') {
          extra = document.createElement('span');
          extra.className = 'ke-x';
          extra.setAttribute('role', 'button');
          extra.tabIndex = 0;
          extra.setAttribute('aria-label', `Remove ${s.label}`);
          extra.textContent = '×';
          const remove = e => {
            e.preventDefault();
            e.stopPropagation();
            this.prefs.set('customKeys', this.customKeys.filter(x => x.id !== s.id).map(({ code, m, name }) => ({ code, m, name })));
            this.prefs.set('keysBar', toggleOnBar(this.bar, s.id, false));
            this._renderKeys();
            this._renderKeysEditor();
          };
          extra.addEventListener('click', remove);
          extra.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') remove(e); });
        }
        chips.append(choice(s, extra));
      }
      box.append(chips);
      groups.push(box);
    }
    this.$('keysGroups').replaceChildren(...groups);
  }

  _ownShortcut(e) {
    if (this.over) return;
    // A hidden pointer comes back with Esc twice (the first Esc still goes to the PC).
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
    if (!(e.ctrlKey && e.altKey && e.shiftKey)) return;
    if (e.code === 'KeyK') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this._togglePalette();
    } else if (e.code === 'KeyT') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.root.classList.contains('dock-orb')) this._fromOrb();
      this._showDock();
      this.$('dockGrip').focus();
    }
  }

  _activity(e) {
    // The first touch or click after the Dock went away shouldn't bring it back (it would cover what you tapped).
    if (e?.type === 'pointerdown') this._closeOverlays();
  }

  // --- the phone keyboard button ---

  // Always on screen on touch devices. Its invisible text box takes the tap itself, so the phone sees a tap on a real
  // text field and opens its keyboard; a tap while the keyboard is open closes it. The Key deck (Win, Ctrl, Esc,
  // arrows…) comes up with the keyboard.
  _wireKeyboardButton() {
    const fab = this.$('kbdFab'), box = this.$('softkbd'), bar = this.$('keysBar');
    let barWasHidden = true;
    const closeIfOpen = e => {
      if (document.activeElement !== box) return;
      e.preventDefault();
      box.blur();
    };
    this._on(box, 'touchstart', closeIfOpen, { passive: false });
    this._on(box, 'mousedown', closeIfOpen);
    this._on(box, 'focus', () => {
      // Opened by itself for a text box on the PC, or by hand with this button.
      this.autoKeyboard = this.openingAuto === true;
      this.openingAuto = false;
      this._inviteKeyboard(null);
      fab.classList.add('open');
      fab.setAttribute('aria-label', 'Hide the keyboard');
      barWasHidden = bar.hidden;
      this._setDeck(true);
    });
    this._on(box, 'blur', () => {
      fab.classList.remove('open');
      fab.setAttribute('aria-label', 'Show the keyboard');
      if (barWasHidden) this._setDeck(false);
    });
    this._syncKeyboardButton();
  }

  // The PC says whether the last tap left it waiting for typing. Bring the keyboard up for a text box (where the
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
      // In full screen Chrome and Edge can pass every key to the page, even Ctrl+W and Esc (Keyboard Lock API).
      navigator.keyboard?.lock?.().catch(() => {});
    }, () => {});
  }

  _fullscreenChanged() {
    const full = !!(document.fullscreenElement || document.webkitFullscreenElement);
    const b = this.$('dkFull');
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

// A window's name for the list: "App: title", or the app alone.
function windowName(w) {
  const app = String(w.app ?? '').trim(), title = String(w.title ?? '').trim();
  return (title && title !== app ? `${app || 'Window'}: ${title}` : app || 'Window').slice(0, 60);
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

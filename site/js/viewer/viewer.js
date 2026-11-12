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

const HIDE_AFTER_MS = 3500;  // the toolbar tucks itself away after this long without being used
const SHOW_ZONE_PX = 56;     // moving the mouse this close to the top brings it back
const PING_MS = 2000;

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
      enabled, onActivity: activity,
    });
    this.keys = new KeyboardInput({
      surface: this.surface, softkbd: this.$('softkbd'), keysBar: this.$('keysBar'), session,
      swapCtrlCmd: () => !this.apple && this.prefs.get('swapCtrlCmd'), enabled, onActivity: activity,
    });
    // Our own shortcut first, before the keys go to the Mac: Ctrl+Alt+Shift+T reaches the toolbar from the keyboard.
    this._on(window, 'keydown', e => this._ownShortcut(e), true);
    this.pointer.attach();
    this.keys.attach();
    this._wireKeyboardButton();

    this._applyStatus({ locked: this.ready.locked, input: this.ready.input });
    const q = this.prefs.get('quality');
    this.$('tbQuality').value = q in QUALITY && !this.guest ? q : this.ready.quality;
    if (!this.guest && q in QUALITY && q !== this.ready.quality) session.send({ t: 'quality', preset: q });

    this._every(PING_MS, () => this._ping());
    this._every(1000, () => this._stats());
    this._ping();
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
    if (this.over) return;
    this.over = true;
    this._micOff();
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
    this.$('endedTitle').focus();
  }

  destroy() {
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
    for (const id of ['ended', 'moreMenu', 'keysBar', 'soundPrompt']) this.$(id).hidden = true;
    this.$('tbKeys').setAttribute('aria-pressed', 'false');
    this.root.classList.remove('tb-on', 'zoomed');
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
    const narrow = window.matchMedia('(max-width: 640px)');
    const placePickers = () => {
      const pickers = [$('tbQuality').closest('label'), $('tbDisplayWrap')];
      if (narrow.matches && !this.guest) $('moreMenu').prepend(...pickers);
      else $('tbKeyboard').before(...pickers);
    };
    placePickers();
    this._on(narrow, 'change', placePickers);

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
      if (e.pointerType !== 'touch' && !this.pointer?.locked && e.clientY < SHOW_ZONE_PX) this._showToolbar();
    });
    this._on(this.surface, 'pointerdown', () => this._toggleMenu(false));
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
    if (!(e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyT') || this.over) return;
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

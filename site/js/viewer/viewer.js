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
    this.inputAllowed = ready.input !== false;
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
    this.$('tbQuality').value = q in QUALITY ? q : this.ready.quality;
    if (q in QUALITY && q !== this.ready.quality) session.send({ t: 'quality', preset: q });

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
    this._on(window, 'resize', () => this.setView(this.view));
    this._on(document, 'fullscreenchange', () => this._fullscreenChanged());
    this._on(document, 'webkitfullscreenchange', () => this._fullscreenChanged());
    this.surface.focus({ preventScroll: true });
    this._showToolbar();
  }

  // The session ended (the Mac said bye, the network went): freeze the picture and say what happened.
  ended(m, { canReconnect = true } = {}) {
    if (this.over) return;
    this.over = true;
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
    this.pointer?.detach();
    this.keys?.detach();
    for (const [el, type, fn, opts] of this.listeners) el.removeEventListener(type, fn, opts);
    this.listeners = [];
    this._clearTimers();
    clearTimeout(this.hideTimer);
    if (this.session) { this.session.onmessage = this.session.onstream = this.session.onlink = () => {}; }
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
    this.root.classList.toggle('zoomed', zoomed);
    this.$('optZoom').disabled = !zoomed;
  }

  // --- messages from the Mac ---

  _message(m) {
    if (m.t === 'pong') {
      if (typeof m.ts === 'number') this.pingMs = Math.max(0, performance.now() - m.ts);
    } else if (m.t === 'status') {
      this._applyStatus(m);
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
      } else {
        this.banners.hide('locked');
      }
    }
    if ('input' in st) {
      this.inputAllowed = st.input !== false;
      this.root.classList.toggle('view-only', !this.inputAllowed);
      this._syncKeyboardButton();
      if (!this.inputAllowed) {
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

    const displays = Array.isArray(this.ready.displays) ? this.ready.displays : [];
    const sel = $('tbDisplay');
    sel.replaceChildren(...displays.map((d, i) => {
      const o = document.createElement('option');
      o.value = String(d.id);
      o.textContent = d.name || `Display ${i + 1}`;
      return o;
    }));
    sel.value = String(this.display.id ?? displays[0]?.id ?? '');
    $('tbDisplayWrap').hidden = displays.length < 2;
    on('tbDisplay', 'change', () => {
      const d = displays.find(x => String(x.id) === sel.value);
      if (!d) return;
      this.display = { id: d.id, width: d.width, height: d.height };
      this.session.send({ t: 'display', id: d.id });
      this.setView(IDENTITY);
    });

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
      if (e.pointerType !== 'touch' && e.clientY < SHOW_ZONE_PX) this._showToolbar();
    });
    this._on(this.surface, 'pointerdown', () => this._toggleMenu(false));
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
    if (show) this._showToolbar();
  }

  _showToolbar() {
    this.root.classList.add('tb-on');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this._hideToolbar(), HIDE_AFTER_MS);
  }

  _hideToolbar() {
    const tb = this.$('toolbar');
    const busy = !this.$('moreMenu').hidden || tb.matches(':hover') || tb.contains(document.activeElement);
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

  _syncKeyboardButton() {
    const fab = this.$('kbdFab');
    fab.hidden = !(this.touchFirst && this.inputAllowed);
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

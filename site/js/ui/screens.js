// The sign-in screens in connect.html: showing one at a time, and the waits on the person (a tap, a code).
// Anything that needs a fresh tap (passkeys, especially in Safari) is started *inside* the click handler: `run` is
// called synchronously there, never after an await.
import { PerchError } from './connection.js';
import { formatWait } from './messages.js';

const STEPS = ['finding', 'connecting', 'checking', 'verifying'];

export class Screens {
  constructor(doc = document) {
    this.doc = doc;
    this.$ = id => doc.getElementById(id);
    this.current = null;
    this.countdown = null;
    this.onCancel = () => {};
    for (const b of doc.querySelectorAll('[data-cancel]')) b.addEventListener('click', () => this.onCancel());
    this._wireCode();
  }

  // Shows #s-<name>; focus goes to `focus` (an element id) or the screen's heading, so screen readers follow along.
  show(name, { focus } = {}) {
    clearInterval(this.countdown);
    for (const s of this.doc.querySelectorAll('#main > .screen')) s.hidden = s.id !== `s-${name}`;
    this.current = name;
    const target = (focus && this.$(focus)) || this.doc.querySelector(`#s-${name} h1`);
    target?.focus({ preventScroll: false });
  }

  setMacName(name) {
    if (!name) return;
    for (const el of this.doc.querySelectorAll('[data-macname]')) el.textContent = name;
  }

  progress(title) {
    this.$('h-progress').textContent = title;
    this.$('progressNote').textContent = '';
    for (const li of this.$('steps').children) li.className = '';
    this.stage('finding');
    this.show('progress');
  }

  // Marks the sign-in steps done / current. Stages after 'verifying' (passkey, code-sent, password) keep the list
  // where it is but bring the progress screen back while the Mac checks.
  stage(stage) {
    const i = STEPS.indexOf(stage);
    if (i >= 0) {
      [...this.$('steps').children].forEach((li, j) => {
        li.className = j < i ? 'done' : j === i ? 'now' : '';
        if (j === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      });
    }
    const notes = {
      passkey: 'Waiting for your passkey…',
      'code-sent': 'Checking the code…',
      password: 'Checking the password…',
      verifying: 'Your Mac is checking…',
    };
    if (stage in notes) {
      this.$('progressNote').textContent = notes[stage];
      if (this.current !== 'progress') {
        for (const s of this.doc.querySelectorAll('#main > .screen')) s.hidden = s.id !== 's-progress';
        this.current = 'progress';
      }
    }
  }

  askPasskey({ name, error, run }) {
    this.setMacName(name);
    return this._askTap('passkey', 'btnPasskeyGo', 'passkeyError', error, run);
  }

  askCreate({ name, error, run }) {
    this.setMacName(name);
    return this._askTap('pair', 'btnCreate', 'pairError', error, run);
  }

  // Resolves to a 6-digit string. `error`: {title, body} from ui/messages.js after a wrong code.
  askCode({ name, error } = {}) {
    this.setMacName(name);
    const input = this.$('code');
    input.value = '';
    input.disabled = false;
    this.$('btnCode').disabled = false;
    this._message('codeError', error ? `${error.title}. ${error.body}` : '');
    this.show('code', { focus: 'code' });
    return new Promise(resolve => { this._codeDone = resolve; });
  }

  // A message with a main button and a quieter one. `m` is from ui/messages.js; a countdown runs while m.wait > 0.
  message(m, { primary, secondary } = {}) {
    this.$('msgTitle').textContent = m.title;
    this.$('msgBody').textContent = m.body;
    const p = this.$('msgPrimary'), s = this.$('msgSecondary'), w = this.$('msgWait');
    p.textContent = primary?.label || 'Back to start';
    p.onclick = () => primary?.onClick?.();
    s.hidden = !secondary;
    if (secondary) {
      s.textContent = secondary.label;
      s.onclick = () => secondary.onClick();
    }
    this.show('message');
    clearInterval(this.countdown);
    w.hidden = true;
    p.disabled = false;
    if (m.wait > 0 && primary?.waits !== false) {
      const until = Date.now() + m.wait * 1000;
      const tick = () => {
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) {
          clearInterval(this.countdown);
          w.hidden = true;
          p.disabled = false;
          return;
        }
        w.hidden = false;
        w.textContent = `You can try again in ${formatWait(left)}.`;
        p.disabled = true;
      };
      tick();
      this.countdown = setInterval(tick, 1000);
    }
  }

  showError(id, text) { this._message(id, text); }

  // --- internals ---

  _askTap(screen, buttonId, errorId, error, run) {
    const btn = this.$(buttonId);
    this._message(errorId, error || '');
    btn.disabled = false;
    this.show(screen, { focus: buttonId });
    return new Promise((resolve, reject) => {
      btn.onclick = () => {
        btn.onclick = null;
        btn.disabled = true;
        let p;
        try { p = run(); } catch (e) { p = Promise.reject(e); }
        p.then(resolve, reject).finally(() => { btn.disabled = false; });
      };
    });
  }

  _message(id, text) {
    const el = this.$(id);
    el.textContent = text || '';
    el.hidden = !text;
  }

  _wireCode() {
    const input = this.$('code');
    const submit = () => {
      const code = input.value.replace(/\D/g, '');
      if (code.length !== 6) {
        this._message('codeError', 'The code has 6 digits.');
        return;
      }
      const done = this._codeDone;
      if (!done) return;
      this._codeDone = null;
      input.disabled = true;
      this.$('btnCode').disabled = true;
      done(code);
    };
    // Keep only digits (pasted codes often come as "123 456"), and go as soon as there are six.
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 6);
      if (digits !== input.value) input.value = digits;
      if (digits.length === 6) submit();
    });
    this.$('codeForm').addEventListener('submit', e => {
      e.preventDefault();
      submit();
    });
  }
}

export const cancelled = () => new PerchError('cancelled');

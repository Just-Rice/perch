// The Command palette: every action and setting of the viewer in one searchable list (Ctrl+Alt+Shift+K, or the Dock's
// search button). viewer.js supplies the actions; this file finds, ranks, draws and runs them.
//
// An action is {id, group, label, icon?, hint?, keywords?, state?(): true | false | string | null, when?(): boolean,
// run()}. `state` shows as an On/Off pill (or a word) on the right; `when` false leaves it out.
import { icon } from '../ui/icons.js';

const fold = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// How well an action matches what was typed: lower is better, null for no match. Every word typed must be found in
// the label, the hint, the group or the keywords; words found at the start of the label (or of one of its words)
// count most.
export function matchScore(action, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const label = fold(action.label);
  const hay = `${label} ${fold(action.hint)} ${fold(action.group)} ${fold(action.keywords)}`;
  let score = 0;
  for (const w of words) {
    if (label.startsWith(w)) continue;
    const i = label.indexOf(w);
    if (i > 0 && /[\s+(\-:]/.test(label[i - 1])) { score += 1; continue; }
    if (i > 0) { score += 2; continue; }
    if (hay.includes(w)) { score += 4; continue; }
    return null;
  }
  return score;
}

// The actions to show for a query: in their groups' order when nothing is typed, best matches first otherwise.
export function filterActions(actions, query) {
  const live = actions.filter(a => !a.when || a.when());
  if (!String(query ?? '').trim()) return live;
  return live
    .map((a, i) => ({ a, i, s: matchScore(a, query) }))
    .filter(x => x.s !== null)
    .sort((x, y) => x.s - y.s || x.i - y.i)
    .map(x => x.a);
}

export class Palette {
  // root: the dialog; input: the search box; list: the <ul>; empty: the "nothing matches" note.
  // actions(): the current list; onClose(): after it closes (focus goes back to the picture there).
  constructor({ root, input, list, empty, actions, onClose = () => {}, focusInput = () => true }) {
    Object.assign(this, { root, input, list, empty, actions, onClose, focusInput });
    this.shown = [];
    this.active = 0;
    this.listeners = [];
    const on = (el, type, fn) => { el.addEventListener(type, fn); this.listeners.push([el, type, fn]); };
    on(input, 'input', () => { this.active = 0; this.render(); });
    on(root, 'keydown', e => this._key(e));
    on(list, 'click', e => {
      const li = e.target.closest('.pi');
      if (li) this.run(Number(li.dataset.i));
    });
    on(list, 'pointermove', e => {
      const li = e.target.closest('.pi');
      if (li && e.pointerType === 'mouse' && Number(li.dataset.i) !== this.active) this._setActive(Number(li.dataset.i), false);
    });
  }

  get open() { return !this.root.hidden; }

  show() {
    this.input.value = '';
    this.active = 0;
    this.root.hidden = false;
    this.render();
    if (this.focusInput()) this.input.focus({ preventScroll: true });
    else { this.root.tabIndex = -1; this.root.focus({ preventScroll: true }); }
  }

  hide() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.onClose();
  }

  render() {
    const q = this.input.value;
    this.shown = filterActions(this.actions(), q);
    this.active = Math.min(this.active, Math.max(0, this.shown.length - 1));
    const items = [];
    let group = null;
    const typed = q.trim();
    this.shown.forEach((a, i) => {
      if (!typed && a.group !== group) {
        group = a.group;
        const h = document.createElement('li');
        h.className = 'pg';
        h.setAttribute('role', 'presentation');
        h.textContent = group;
        items.push(h);
      }
      items.push(this._item(a, i, typed));
    });
    this.list.replaceChildren(...items);
    this.empty.hidden = this.shown.length > 0;
    this._setActive(this.active, true);
  }

  run(i) {
    const a = this.shown[i];
    if (!a || a.disabled?.()) return;
    this.hide();
    a.run();
  }

  detach() {
    for (const [el, type, fn] of this.listeners) el.removeEventListener(type, fn);
    this.listeners = [];
  }

  _item(a, i, typed) {
    const li = document.createElement('li');
    li.className = 'pi';
    li.id = `pi-${i}`;
    li.dataset.i = String(i);
    li.dataset.id = a.id;
    li.setAttribute('role', 'option');
    if (a.disabled?.()) li.setAttribute('aria-disabled', 'true');
    const ico = document.createElement('span');
    ico.className = 'pi-ico';
    ico.append(icon(a.icon || 'chevron', { size: 18 }));
    const label = document.createElement('span');
    label.className = 'pi-label';
    label.append(...highlight(a.label, typed));
    li.append(ico, label);
    if (a.hint) {
      const h = document.createElement('span');
      h.className = 'pi-hint';
      h.textContent = a.hint;
      li.append(h);
    }
    const st = a.state?.();
    if (st !== undefined && st !== null) {
      const s = document.createElement('span');
      s.className = `pi-state${st === true ? ' on' : ''}`;
      s.textContent = st === true ? 'On' : st === false ? 'Off' : String(st);
      li.append(s);
      if (typeof st === 'boolean') li.setAttribute('aria-checked', String(st));
    }
    return li;
  }

  _setActive(i, scroll) {
    this.active = i;
    let current = null;
    for (const li of this.list.querySelectorAll('.pi')) {
      const on = Number(li.dataset.i) === i;
      li.setAttribute('aria-selected', String(on));
      if (on) current = li;
    }
    if (current) {
      this.input.setAttribute('aria-activedescendant', current.id);
      if (scroll) current.scrollIntoView({ block: 'nearest' });
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }

  _key(e) {
    const n = this.shown.length;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.hide(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!n) return;
      this._setActive((this.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n, true);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      if (n) this._setActive(Math.min(n - 1, Math.max(0, this.active + (e.key === 'PageDown' ? 8 : -8))), true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.run(this.active);
    } else if (e.key === 'Tab') {
      e.preventDefault(); // focus stays in the palette
    }
  }
}

// The label with the typed words marked.
function highlight(text, typed) {
  const words = fold(typed).split(/\s+/).filter(Boolean);
  if (!words.length) return [text];
  const low = fold(text);
  const marks = new Array(text.length).fill(false);
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0) for (let j = i; j < i + w.length && j < marks.length; j++) marks[j] = true;
  }
  const out = [];
  let run = '', on = false;
  const flush = () => {
    if (!run) return;
    if (on) { const m = document.createElement('mark'); m.textContent = run; out.push(m); } else out.push(run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (marks[i] !== on) { flush(); on = marks[i]; }
    run += text[i];
  }
  flush();
  return out;
}

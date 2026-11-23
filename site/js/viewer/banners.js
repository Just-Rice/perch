// Status notes over the Mac's picture: "Your Mac is locked", "View only", "The connection is slow"… One per id, so a
// status message that repeats every few seconds updates its note instead of piling up new ones.
import { icon } from '../ui/icons.js';

export class Banners {
  constructor(root) {
    this.root = root;
    this.items = new Map(); // id -> element
  }

  // kind: info | warn | bad. action: {label, onClick}. dismissible: show a close button (it comes back only if the
  // situation changes, e.g. the link becomes slow again after being good).
  show(id, { kind = 'info', icon: iconName = 'info', title, body = '', action, dismissible = false }) {
    const key = `${kind}|${title}|${body}|${action?.label || ''}`;
    const el = this.items.get(id);
    if (el?.dataset.key === key || this.dismissed.get(id) === key) return;
    const fresh = document.createElement('div');
    fresh.className = `banner ${kind}`;
    fresh.dataset.id = id;
    fresh.dataset.key = key;
    fresh.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
    const text = document.createElement('div');
    text.className = 'banner-text';
    const t = document.createElement('b');
    t.textContent = title;
    text.append(t);
    if (body) {
      const p = document.createElement('span');
      p.textContent = ' ' + body;
      text.append(p);
    }
    fresh.append(icon(iconName), text);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = action.label;
      b.addEventListener('click', action.onClick);
      fresh.append(b);
    }
    if (dismissible) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'banner-x';
      x.setAttribute('aria-label', 'Hide this note');
      x.append(icon('close', { size: 18 }));
      x.addEventListener('click', () => {
        fresh.remove();
        this.items.delete(id);
        this.dismissed.set(id, key);
      });
      fresh.append(x);
    }
    if (el) el.replaceWith(fresh); else this.root.append(fresh);
    this.items.set(id, fresh);
  }

  hide(id) {
    this.items.get(id)?.remove();
    this.items.delete(id);
    this.dismissed.delete(id); // if it comes back later, show it again
  }

  has(id) { return this.items.has(id); }

  clear() {
    this.root.replaceChildren();
    this.items.clear();
    this.dismissed.clear();
  }

  get dismissed() {
    this._dismissed ||= new Map();
    return this._dismissed;
  }
}

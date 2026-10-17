// Small DOM helpers. Everything the page shows is set as text (never as HTML), so a device label or an activity line
// can't inject markup.

export const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Setup page is missing #${id}`);
  return el;
};

// h('p', {class: 'muted'}, 'text', child) -> element. Attributes starting with "on" are event listeners.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const show = (el, on = true) => { el.hidden = !on; };

export function setText(el, text) {
  const t = String(text ?? '');
  if (el.textContent !== t) el.textContent = t;
}

// Shows a message in a message element (or hides it when the text is empty).
export function say(el, text) {
  setText(el, text || '');
  el.hidden = !text;
}

// Runs an action from a button: the button shows it's busy and can't be pressed twice, and a failure is shown in
// `errorEl` in plain words. Resolves to the action's result, or undefined when it failed.
export async function busy(button, errorEl, fn) {
  if (button?.getAttribute('aria-busy') === 'true') return undefined;
  if (errorEl) say(errorEl, '');
  const wasDisabled = button?.disabled;
  if (button) { button.setAttribute('aria-busy', 'true'); button.disabled = true; }
  try {
    return await fn();
  } catch (e) {
    if (errorEl) say(errorEl, e?.message || 'Something went wrong. Please try again.');
    return undefined;
  } finally {
    if (button) { button.removeAttribute('aria-busy'); button.disabled = wasDisabled ?? false; }
  }
}

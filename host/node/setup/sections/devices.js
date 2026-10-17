// The paired devices, with Rename and Remove. Rows are kept and updated in place (not rebuilt) when Perch sends a
// new state, so a rename being typed or a removal being confirmed isn't wiped out by a live update.
import { $, h, setText, show, say, busy } from '../lib/dom.js';
import { confirmInline } from '../lib/confirm.js';
import { ago, dateOnly } from '../lib/time.js';

const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm3 17h2',
  tablet: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm5 17h2',
  computer: 'M4 5h16a1 1 0 0 1 1 1v10H3V6a1 1 0 0 1 1-1zM1 19h22',
};

function kindOf(label) {
  if (/ipad|tablet|tab\b/i.test(label)) return 'tablet';
  if (/iphone|android|phone|pixel|galaxy/i.test(label)) return 'phone';
  return 'computer';
}

function icon(kind) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[kind]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

export function devices(ctx) {
  const list = $('deviceList');
  const error = $('devicesError');
  const rows = new Map(); // device id -> row parts

  function makeRow(d) {
    const iconBox = h('span', { class: 'device-icon' });
    const label = h('div', { class: 'device-label' });
    const meta = h('div', { class: 'device-meta' });
    const now = h('div', { class: 'device-now', hidden: true }, 'Connected now');
    const renameBtn = h('button', { type: 'button', class: 'btn quiet' }, 'Rename');
    const removeBtn = h('button', { type: 'button', class: 'btn quiet danger-quiet' }, 'Remove');
    const buttons = h('div', { class: 'device-buttons confirm-host' }, renameBtn, removeBtn);
    const li = h('li', { class: 'device', 'data-id': d.id },
      h('div', { class: 'device-top' }, iconBox, h('div', { class: 'device-main' }, label, meta, now), buttons));
    const row = { li, iconBox, label, meta, now, renameBtn, removeBtn, buttons, form: null, kind: null, device: d };

    renameBtn.addEventListener('click', () => openRename(row));
    removeBtn.addEventListener('click', () => {
      const connected = ctx.state?.session?.deviceId === row.device.id;
      confirmInline(removeBtn, {
        container: row.li,
        text: `Remove “${row.device.label}”? It won't be able to connect any more` +
          (connected ? ', and it will be disconnected now.' : '.'),
        yes: 'Remove', no: 'Keep it', danger: true,
        onYes: async () => {
          await ctx.post('deviceRemove', { id: row.device.id });
          $('hDevices').focus();
        },
      });
    });
    return row;
  }

  function openRename(row) {
    if (row.form) { row.form.querySelector('input').focus(); return; }
    const inputId = `rename-${row.device.id}`;
    const input = h('input', { type: 'text', id: inputId, maxlength: 64, value: row.device.label, autocomplete: 'off' });
    const save = h('button', { type: 'submit', class: 'btn primary' }, 'Save');
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
    const msg = h('p', { class: 'msg bad', role: 'alert', hidden: true });
    const form = h('form', { class: 'device-rename-form', novalidate: true },
      h('label', { for: inputId, class: 'sr-label' }, `New name for “${row.device.label}”`),
      h('div', { class: 'device-rename' }, input, save, cancel), msg);
    const close = () => { form.remove(); row.form = null; row.buttons.hidden = false; render(ctx.state); row.renameBtn.focus(); };
    cancel.addEventListener('click', close);
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const label = input.value.trim();
      if (!label) { say(msg, 'Give the device a name.'); input.focus(); return; }
      if (label === row.device.label) { close(); return; }
      const r = await busy(save, msg, () => ctx.post('deviceRename', { id: row.device.id, label }));
      if (r !== undefined) close();
    });
    row.form = form;
    row.buttons.hidden = true;
    row.li.append(form);
    input.focus();
    input.select();
  }

  $('hDevices').tabIndex = -1;
  $('removeAllBtn').addEventListener('click', (e) => {
    confirmInline(e.currentTarget, {
      text: 'Remove every device? None of them will be able to connect until you pair them again.',
      yes: 'Remove all devices', no: 'Keep them', danger: true,
      onYes: async () => {
        await ctx.post('devicesRemoveAll');
        $('hDevices').focus();
      },
    });
  });

  function render(st) {
    if (!st) return;
    const devs = st.devices ?? [];
    const seen = new Set();
    devs.forEach((d, i) => {
      seen.add(d.id);
      let row = rows.get(d.id);
      if (!row) { row = makeRow(d); rows.set(d.id, row); }
      row.device = d;
      const kind = kindOf(d.label);
      if (row.kind !== kind) { row.kind = kind; row.iconBox.replaceChildren(icon(kind)); }
      setText(row.label, d.label);
      const used = d.lastUsedAt ? `last used ${ago(d.lastUsedAt)}` : 'not used yet';
      setText(row.meta, `Added ${dateOnly(d.createdAt)} · ${used}`);
      show(row.now, st.session?.deviceId === d.id);
      // Keep Perch's order, but only move a row when it's out of place: moving it would drop the focus inside it.
      if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] ?? null);
    });
    for (const [id, row] of rows) {
      if (!seen.has(id)) { row.li.remove(); rows.delete(id); }
    }
    show($('devicesEmpty'), devs.length === 0);
    show($('removeAllHost'), devs.length > 1);
    if (devs.length === 0) say(error, '');
  }

  return { render };
}

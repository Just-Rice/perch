// Line icons drawn with plain SVG paths (24×24, stroked in the current text colour). Built with DOM calls rather than
// markup strings so the page's strict Content-Security-Policy has nothing to object to.
const PATHS = {
  keyboard: 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  sound: 'M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  muted: 'M11 5 6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6',
  fullscreen: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
  'fullscreen-exit': 'M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3',
  stats: 'M5 20v-6M12 20V4M19 20v-10',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M18 6 6 18M6 6l12 12',
  power: 'M12 3v9M18.4 6.6a9 9 0 1 1-12.8 0',
  display: 'M3 4h18v12H3zM8 20h8M12 16v4',
  mac: 'M5 5h14a1 1 0 0 1 1 1v10H4V6a1 1 0 0 1 1-1zM2 19h20',
  chevron: 'M9 6l6 6-6 6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  key: 'M8 11a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM11 12l9-9M16 7l3 3M14 9l2 2',
  lock: 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  warn: 'M12 3 2 20h20L12 3zM12 10v4M12 17h.01',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v6M12 7.5h.01',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  zoom: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-5-5M8 11h6',
  blank: 'M5 3h10l4 4v14H5zM15 3v4h4',
  tab: 'M3 7h18v13H3zM3 7l3-4h6l2 4',
};

const NS = 'http://www.w3.org/2000/svg';

export function icon(name, { size = 22, label } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'icon');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name] || PATHS.info);
  svg.append(path);
  return svg;
}

// Fills every <… data-icon="name"> in `root` with its icon (before any text it has).
export function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.querySelector(':scope > svg.icon')) continue;
    el.prepend(icon(el.dataset.icon));
  }
}

// Swaps the icon inside an element (sound ↔ muted, full screen ↔ exit).
export function setIcon(el, name) {
  el.dataset.icon = name;
  el.querySelector(':scope > svg.icon')?.remove();
  el.prepend(icon(name));
}

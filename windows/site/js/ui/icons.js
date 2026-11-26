// Line icons drawn with plain SVG paths (24×24, stroked in the current text colour). Built with DOM calls rather than
// markup strings so the page's strict Content-Security-Policy has nothing to object to.
const PATHS = {
  keyboard: 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  sound: 'M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3M8 21h8',
  pointer: 'M5 3l14 8-6 1.5L10 19 5 3zM13 12.5l5 5',
  paste: 'M9 4h6v3H9zM8 5H5v16h14V5h-3M8 12h8M8 16h5',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  hideBar: 'M4 4h16M8 10l4 4 4-4M12 14V8M4 20h16',
  muted: 'M11 5 6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6',
  fullscreen: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
  'fullscreen-exit': 'M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3',
  stats: 'M5 20v-6M12 20V4M19 20v-10',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M18 6 6 18M6 6l12 12',
  power: 'M12 3v9M18.4 6.6a9 9 0 1 1-12.8 0',
  display: 'M3 4h18v12H3zM8 20h8M12 16v4',
  displays: 'M2 7h11v8H2zM15 4h7v6h-7zM5 19h5M7.5 15v4',
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
  pc: 'M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 20h6M12 16v4',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  keys: 'M3 7h8v8H3zM13 7h8v8h-8zM5 18h4M15 18h4M6 10l1 2 1-2M16 10.5h2',
  orb: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 12a8 8 0 0 0 16 0',
  collapse: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM4 4l4 4M20 4l-4 4M4 20l4-4M20 20l-4-4',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3zM9 12l2 2 4-4',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
  window: 'M3 5h18v14H3zM3 9h18',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  wifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01',
  check: 'M5 12l5 5 9-10',
  plus: 'M12 5v14M5 12h14',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  touch: 'M9 11V5a2 2 0 0 1 4 0v5M13 10a2 2 0 0 1 4 0v2M17 12a2 2 0 0 1 4 0v3a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.4L4 15a2 2 0 0 1 3.4-2L9 15',
  clipboard: 'M9 4h6v3H9zM8 5H5v16h14V5h-3',
  dock: 'M3 15h18v4H3zM6 17h.01M10 17h.01M14 17h.01M3 5h18v7H3z',
  windows: 'M4 5l7-1v7.5H4zM13 3.7 20 3v8.5h-7zM4 12.5h7V20l-7-1zM13 12.5h7V21l-7-1z',
  globe: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  user: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21a8 8 0 0 1 16 0',
  download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
  arrows: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
  speaker: 'M6 3h12v18H6zM12 7h.01M12 11a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
};

const NS = 'http://www.w3.org/2000/svg';

export function icon(name, { size = 20, label } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' || name === 'grip' ? '3' : '1.75');
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

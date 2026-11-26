// QR codes as inline SVG, drawn from qrcode-generator's module grid (the global `qrcode` from vendor/qrcode.js).
// Error correction level M: survives a bit of glare or a smudged screen and keeps the code small enough to scan
// from across a desk. Always black on white with a 4-module quiet zone, which every camera app reads.

const NS = 'http://www.w3.org/2000/svg';
const QUIET = 4;

export function qrSvg(text, label) {
  const qr = globalThis.qrcode(0, 'M'); // 0 = the smallest version that fits
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const size = n + QUIET * 2;
  // One path for every dark module, merging runs along each row so the path stays short.
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      let run = 1;
      while (c + run < n && qr.isDark(r, c + run)) run++;
      d += `M${c + QUIET} ${r + QUIET}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.dataset.modules = String(n);
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}

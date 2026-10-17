#!/usr/bin/env node
// Renders site/img/icon.svg into Perch.app's icon, host/app/Resources/AppIcon.icns (committed, so building the app
// never needs Chrome). Run it again only when the artwork changes:
//
//   node host/scripts/make-icon.mjs [--png <dir>]      (--png also keeps the rendered PNGs there for a look)
//
// Each size is drawn by headless Chrome straight from the SVG (no scaling of one big bitmap, so the small sizes stay
// sharp), then iconutil packs them. The picture sits on Apple's macOS icon grid: the rounded square fills 824 of
// 1024 pixels, centred, with a soft shadow at the larger sizes, so it lines up with other apps in the Dock and Finder.
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../../tests/e2e/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SVG = path.join(ROOT, 'site/img/icon.svg');
const OUT = path.join(ROOT, 'host/app/Resources/AppIcon.icns');

// iconutil's file names and the pixel size each one needs.
const ICONSET = {
  'icon_16x16.png': 16, 'icon_16x16@2x.png': 32,
  'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
  'icon_128x128.png': 128, 'icon_128x128@2x.png': 256,
  'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
  'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
};

const args = process.argv.slice(2);
const pngDir = args[0] === '--png' ? path.resolve(args[1] ?? '') : null;

function pageFor(size, svgDataUrl) {
  const body = size * 824 / 1024;
  const pad = (size - body) / 2;
  // A shadow only where it can be seen; at 16 and 32 px it would just smudge the edge.
  const shadow = size >= 64 ? `filter: drop-shadow(0 ${size * 10 / 1024}px ${size * 10 / 1024}px rgba(0,0,0,.3));` : '';
  return `<!doctype html><html><head><style>
    html, body { margin: 0; width: ${size}px; height: ${size}px; background: transparent; overflow: hidden; }
    img { position: absolute; left: ${pad}px; top: ${pad}px; width: ${body}px; height: ${body}px; ${shadow} }
  </style></head><body><img src="${svgDataUrl}"></body></html>`;
}

const svgDataUrl = 'data:image/svg+xml;base64,' + readFileSync(SVG).toString('base64');
const work = mkdtempSync(path.join(tmpdir(), 'perch-icon-'));
const iconset = path.join(work, 'AppIcon.iconset');
mkdirSync(iconset);
const chrome = await launchChrome();
try {
  const page = await chrome.cdp.newPage();
  await page.send('Page.enable');
  await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const rendered = new Map(); // pixel size -> PNG bytes
  for (const size of new Set(Object.values(ICONSET))) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
    await page.navigate('data:text/html;base64,' + Buffer.from(pageFor(size, svgDataUrl)).toString('base64'));
    // (Runtime.evaluate directly: the driver's eval() leaves a 60 s timer running that keeps Node alive.)
    await page.send('Runtime.evaluate', { expression: 'document.querySelector("img").decode()', awaitPromise: true });
    const { data } = await page.send('Page.captureScreenshot', {
      format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
    });
    rendered.set(size, Buffer.from(data, 'base64'));
  }
  for (const [name, size] of Object.entries(ICONSET)) writeFileSync(path.join(iconset, name), rendered.get(size));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(work, 'AppIcon.icns')]);
  copyFileSync(path.join(work, 'AppIcon.icns'), OUT);
  if (pngDir) {
    mkdirSync(pngDir, { recursive: true });
    for (const name of Object.keys(ICONSET)) copyFileSync(path.join(iconset, name), path.join(pngDir, name));
  }
  console.log(`wrote ${path.relative(ROOT, OUT)}${pngDir ? ` and the PNGs in ${pngDir}` : ''}`);
} finally {
  await chrome.close();
  rmSync(work, { recursive: true, force: true });
}

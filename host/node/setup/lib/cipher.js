// The background: slow columns of hex and base32 drifting down behind the cards, each led by one brighter character,
// now and then re-keying a glyph. One canvas fixed behind the page (setup.css .cipher); the cards are solid, so text
// never sits on the pattern. It stops moving for anyone who asks their Mac for less motion (one still frame), pauses
// while the tab is in the background, and draws at most 30 frames a second.
//
// The colour is --glyph (an "r, g, b" triplet) from setup.css, so it follows light and dark mode; ALPHA is how strong
// the pattern is (the owner chose "bold": 0.27 on dark, a quarter more on light, where the same alpha reads fainter).
const ALPHA = 0.27;
const STEP = 15;          // px between columns
const LINE = 16;          // px between characters in a column
const FRAME_MS = 1000 / 30;
const HEX = '0123456789abcdef';
const B32 = 'ABCDEFGHJKMNPQRSTVWXYZ234567';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const randomChar = () => (Math.random() < 0.7 ? HEX[Math.random() * 16 | 0] : B32[Math.random() * B32.length | 0]);

export function startCipher(canvas) {
  if (!canvas?.getContext) return () => {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  let w = 0, h = 0, columns = [], raf = 0, last = 0, colour = '15, 118, 110', alpha = ALPHA;

  const column = (i, scatter) => {
    const len = 6 + (Math.random() * 18 | 0);
    return { i, x: i * STEP + 4, y: scatter ? Math.random() * (h + len * LINE) : -Math.random() * h * 0.6,
      speed: 9 + Math.random() * 24, len, chars: Array.from({ length: len }, randomChar) };
  };

  function readTheme() {
    colour = getComputedStyle(document.documentElement).getPropertyValue('--glyph').trim() || colour;
    alpha = ALPHA * (dark.matches ? 1 : 1.25);
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const nw = window.innerWidth, nh = window.innerHeight;
    canvas.width = Math.round(nw * dpr);
    canvas.height = Math.round(nh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const widthChanged = nw !== w;
    w = nw; h = nh;
    if (widthChanged || !columns.length) columns = Array.from({ length: Math.ceil(w / STEP) }, (_, i) => column(i, true));
    paint(0);
  }

  function paint(dt) {
    ctx.clearRect(0, 0, w, h);
    ctx.font = `12px ${MONO}`;
    ctx.textBaseline = 'top';
    for (const c of columns) {
      c.y += c.speed * dt;
      if (c.y - c.len * LINE > h) Object.assign(c, column(c.i, false));
      if (dt && Math.random() < 0.015) c.chars[Math.random() * c.len | 0] = randomChar();
      for (let k = 0; k < c.len; k++) {
        const y = c.y - k * LINE;
        if (y < -LINE || y > h) continue;
        const a = k === 0 ? Math.min(1, alpha * 2.6) : alpha * (1 - k / c.len);
        ctx.fillStyle = `rgba(${colour}, ${a.toFixed(3)})`;
        ctx.fillText(c.chars[k], c.x, y);
      }
    }
  }

  function frame(t) {
    raf = 0;
    if (document.hidden || reduced.matches) { last = 0; return; }
    if (last && t - last < FRAME_MS) { raf = requestAnimationFrame(frame); return; }
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    paint(dt);
    raf = requestAnimationFrame(frame);
  }
  const run = () => { if (!raf && !reduced.matches && !document.hidden) raf = requestAnimationFrame(frame); };

  readTheme();
  resize();
  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', run);
  dark.addEventListener?.('change', () => { readTheme(); paint(0); });
  reduced.addEventListener?.('change', () => { paint(0); run(); });
  run();
  return () => { cancelAnimationFrame(raf); raf = 0; removeEventListener('resize', resize); };
}

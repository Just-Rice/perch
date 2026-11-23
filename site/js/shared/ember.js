// The background: embers. A few large, slow, warm glows drifting behind the page, and a handful of tiny sparks
// rising and fading out. One canvas fixed behind everything (.ember in the page's CSS). Very subtle on purpose: it is
// atmosphere, not decoration to look at.
//
// It stops moving for anyone who asks their device for less motion (one still frame), pauses while the tab is in the
// background, and draws at most 24 frames a second, at a low resolution for the glows (they are blurry anyway).
//
// The website and the PC's Control Center both use it; the Control Center can't load the website's files, so
// host/setup/lib/ember.js is an exact copy of site/js/shared/ember.js (a test keeps them the same).
//
// Colours come from the page's CSS as "r, g, b" triplets, so they follow light and dark mode:
//   --ember-a (the glows' main colour), --ember-b (their second colour), --spark (the sparks).
// Options:
//   calm():   an element whose box holds running text: sparks over it are drawn at CALM of their strength, so the
//             text stays easy to read. Without it, sparks are even everywhere (the Control Center, whose text sits
//             on solid cards).
//   paused(): true while the background shouldn't run at all (the viewer, showing the PC's screen, where it would
//             only cost the device's power). Checked whenever the <body>'s class changes.
const FRAME_MS = 1000 / 24;
const CALM = 0.25;
const GLOW_SCALE = 0.25;     // the glows are drawn at a quarter of the resolution, then stretched
const GLOW_ALPHA = { dark: 0.15, light: 0.11 };
const SPARK_ALPHA = { dark: 0.75, light: 0.5 };
const SPARKS_PER_MPX = 26;   // sparks per million CSS pixels of window
const MAX_SPARKS = 46;

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

export function startEmbers(canvas, { calm = null, paused = () => false } = {}) {
  if (!canvas?.getContext) return () => {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  // The glows go to a small canvas of their own first.
  const glowCanvas = document.createElement('canvas');
  const gctx = glowCanvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  let w = 0, h = 0, raf = 0, last = 0, clock = rand(0, 1000);
  let colours = { a: '255, 122, 61', b: '255, 193, 94', spark: '255, 170, 90' };
  let glowAlpha = GLOW_ALPHA.dark, sparkAlpha = SPARK_ALPHA.dark;

  // Each glow wanders on its own slow Lissajous path (periods of a minute or two), breathing a little.
  const glows = Array.from({ length: 4 }, (_, i) => ({
    cx: [0.12, 0.88, 0.7, 0.3][i], cy: [0.15, 0.25, 0.9, 0.75][i],
    ax: rand(0.08, 0.16), ay: rand(0.06, 0.14),
    fx: TAU / rand(70, 140), fy: TAU / rand(80, 150), px: rand(0, TAU), py: rand(0, TAU),
    r: [0.55, 0.45, 0.5, 0.38][i], second: i % 2 === 1, breathe: TAU / rand(20, 40),
  }));
  let sparks = [];

  const spark = (anywhere) => ({
    x: rand(0, w), y: anywhere ? rand(0, h) : h + rand(4, 40),
    vy: rand(7, 20), drift: rand(4, 14), phase: rand(0, TAU), wobble: TAU / rand(4, 9),
    size: rand(0.6, 1.7), life: anywhere ? rand(0, 1) : 0, span: rand(9, 22), twinkle: TAU / rand(0.8, 2.2),
  });

  function readTheme() {
    const css = getComputedStyle(document.documentElement);
    const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    colours = { a: get('--ember-a', colours.a), b: get('--ember-b', colours.b), spark: get('--spark', colours.spark) };
    glowAlpha = dark.matches ? GLOW_ALPHA.dark : GLOW_ALPHA.light;
    sparkAlpha = dark.matches ? SPARK_ALPHA.dark : SPARK_ALPHA.light;
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const nw = window.innerWidth, nh = window.innerHeight;
    canvas.width = Math.round(nw * dpr);
    canvas.height = Math.round(nh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glowCanvas.width = Math.max(1, Math.round(nw * GLOW_SCALE));
    glowCanvas.height = Math.max(1, Math.round(nh * GLOW_SCALE));
    const grew = nw * nh > w * h * 1.2 || !sparks.length;
    w = nw; h = nh;
    const want = Math.min(MAX_SPARKS, Math.round((w * h / 1e6) * SPARKS_PER_MPX) + 6);
    if (grew || sparks.length > want) sparks = Array.from({ length: want }, () => spark(true));
    paint(0);
  }

  function paintGlows() {
    const gw = glowCanvas.width, gh = glowCanvas.height, big = Math.max(gw, gh * 0.6);
    gctx.clearRect(0, 0, gw, gh);
    gctx.globalCompositeOperation = 'lighter';
    for (const g of glows) {
      const x = (g.cx + g.ax * Math.sin(clock * g.fx + g.px)) * gw;
      const y = (g.cy + g.ay * Math.cos(clock * g.fy + g.py)) * gh;
      const r = g.r * big * (1 + 0.06 * Math.sin(clock * g.breathe));
      const c = g.second ? colours.b : colours.a;
      const grad = gctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${c}, ${glowAlpha.toFixed(3)})`);
      grad.addColorStop(0.45, `rgba(${c}, ${(glowAlpha * 0.42).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${c}, 0)`);
      gctx.fillStyle = grad;
      gctx.fillRect(0, 0, gw, gh);
    }
    gctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(glowCanvas, 0, 0, w, h);
  }

  function paint(dt) {
    ctx.clearRect(0, 0, w, h);
    if (paused()) return;
    clock += dt;
    paintGlows();
    const el = calm?.();
    const box = el ? el.getBoundingClientRect() : null;
    for (let i = 0; i < sparks.length; i++) {
      let s = sparks[i];
      s.life += dt / s.span;
      s.y -= s.vy * dt;
      if (s.life >= 1 || s.y < -10) { s = sparks[i] = spark(false); }
      const x = s.x + Math.sin(clock * s.wobble + s.phase) * s.drift;
      // Fade in, glow, fade out; with a gentle flicker.
      const fade = Math.sin(Math.PI * Math.min(1, s.life));
      const flicker = 0.7 + 0.3 * Math.sin(clock * s.twinkle + s.phase);
      let a = sparkAlpha * fade * flicker;
      if (box && box.width && x > box.left && x < box.right && s.y > box.top && s.y < box.bottom) a *= CALM;
      if (a < 0.01) continue;
      const halo = s.size * 4;
      const grad = ctx.createRadialGradient(x, s.y, 0, x, s.y, halo);
      grad.addColorStop(0, `rgba(${colours.spark}, ${a.toFixed(3)})`);
      grad.addColorStop(0.3, `rgba(${colours.spark}, ${(a * 0.35).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${colours.spark}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, s.y, halo, 0, TAU);
      ctx.fill();
    }
  }

  function frame(t) {
    raf = 0;
    if (document.hidden || reduced.matches || paused()) { last = 0; return; }
    if (last && t - last < FRAME_MS) { raf = requestAnimationFrame(frame); return; }
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    paint(dt);
    raf = requestAnimationFrame(frame);
  }
  const run = () => { if (!raf && !reduced.matches && !document.hidden && !paused()) raf = requestAnimationFrame(frame); };

  readTheme();
  resize();
  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', run);
  dark.addEventListener?.('change', () => { readTheme(); paint(0); });
  reduced.addEventListener?.('change', () => { paint(0); run(); });
  // Paused or not can change with the page's state (the viewer opening and closing).
  const watcher = typeof MutationObserver === 'function' && document.body
    ? new MutationObserver(() => { paint(0); run(); }) : null;
  watcher?.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  run();
  return () => {
    cancelAnimationFrame(raf); raf = 0; watcher?.disconnect();
    removeEventListener('resize', resize); document.removeEventListener('visibilitychange', run);
  };
}

// Demo mode, for checking the viewer without a Mac: connect.html?demo=1, only when served from localhost/127.0.0.1
// (ui/env.js). A canvas draws a moving test picture that stands in for the Mac's screen, and every message the viewer
// would send to the Mac is listed on the page instead. Nothing touches the network.
import { Viewer } from '../viewer/viewer.js';

const DISPLAYS = [
  { id: 1, name: 'Built-in Display', width: 1512, height: 982, main: true },
  { id: 2, name: 'Studio Display', width: 2560, height: 1440, main: false },
];

export function startDemo(app) {
  const params = app.env.params;
  const canvas = document.createElement('canvas');
  let display = DISPLAYS[0];
  const setSize = d => { canvas.width = Math.round(d.width / 2); canvas.height = Math.round(d.height / 2); };
  setSize(display);
  const ctx = canvas.getContext('2d');
  let last = null; // last pointer position the "Mac" got, drawn as a cursor
  let clicks = [];  // recent clicks, drawn as rings

  const draw = now => {
    const w = canvas.width, h = canvas.height;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#1f6f8b');
    g.addColorStop(0.5, '#2a9d8f');
    g.addColorStop(1, '#e9c46a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // A grid every tenth of the screen, so mapped positions can be checked by eye.
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      ctx.beginPath(); ctx.moveTo((w * i) / 10, 0); ctx.lineTo((w * i) / 10, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, (h * i) / 10); ctx.lineTo(w, (h * i) / 10); ctx.stroke();
    }
    // A "window" and a moving ball, so a frozen picture is obvious.
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.fillRect(w * 0.08, h * 0.12, w * 0.5, h * 0.55);
    ctx.fillStyle = '#141820';
    ctx.font = `600 ${Math.round(h / 16)}px system-ui, sans-serif`;
    ctx.fillText('Perch demo', w * 0.11, h * 0.24);
    ctx.font = `${Math.round(h / 28)}px system-ui, sans-serif`;
    ctx.fillText(`${display.name} · ${display.width} × ${display.height}`, w * 0.11, h * 0.32);
    ctx.fillText(new Date().toLocaleTimeString(), w * 0.11, h * 0.39);
    const t = now / 1000;
    ctx.fillStyle = '#e76f51';
    ctx.beginPath();
    ctx.arc(w * (0.5 + 0.38 * Math.cos(t)), h * (0.75 + 0.15 * Math.sin(t * 1.7)), h / 18, 0, Math.PI * 2);
    ctx.fill();
    clicks = clicks.filter(c => now - c.t < 800);
    for (const c of clicks) {
      ctx.strokeStyle = c.b === 2 ? '#ffd166' : '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x * w, c.y * h, 6 + (now - c.t) / 25, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (last) {
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.moveTo(last.x * w, last.y * h);
      ctx.lineTo(last.x * w + 12, last.y * h + 16);
      ctx.lineTo(last.x * w + 4, last.y * h + 15);
      ctx.closePath();
      ctx.fill();
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  const stream = canvas.captureStream(30);
  const list = document.getElementById('demoList');
  const messages = [];
  app.demoMessages = messages;
  const log = (channel, m) => {
    messages.push({ channel, ...m });
    if (m.t === 'm' || m.t === 'b' || m.t === 'w') last = { x: m.x, y: m.y };
    if (m.t === 'b' && m.d) clicks.push({ x: m.x, y: m.y, b: m.b, t: performance.now() });
    // Pointer moves come many times a second: show only the latest one, at the top.
    let li = m.t === 'm' ? list.querySelector('li.move') : null;
    if (!li) {
      li = document.createElement('li');
      if (m.t === 'm') li.className = 'move';
      list.prepend(li);
    }
    li.textContent = `${channel}: ${JSON.stringify(m)}`;
    while (list.children.length > 60) list.lastChild.remove();
  };

  const ready = {
    t: 'ready', name: 'demo-mac-0000', hv: 'demo', display: { id: display.id, width: display.width, height: display.height },
    displays: DISPLAYS, quality: 'balanced', audio: params.get('sound') === 'blocked', input: params.get('viewonly') !== '1',
    locked: params.get('locked') === '1',
  };
  const session = {
    stream,
    onmessage: () => {},
    onstream: () => {},
    onlink: () => {},
    send(m) {
      log('control', m);
      if (m.t === 'ping') setTimeout(() => this.onmessage({ t: 'pong', n: m.n, ts: m.ts }), 12);
      if (m.t === 'display') {
        display = DISPLAYS.find(d => d.id === m.id) || display;
        setSize(display);
        setTimeout(() => this.onmessage({ t: 'status', width: display.width, height: display.height }), 50);
      }
    },
    sendInput(m) { log('input', m); },
    sendPointer(m) { log('pointer', m); },
    async getStats() { return new Map(); },
    close() {},
  };

  document.getElementById('app').hidden = true;
  document.getElementById('demoLog').hidden = params.get('log') === '0';
  const viewer = new Viewer({
    root: document.getElementById('viewer'), session, hi: { name: ready.name }, ready, prefs: app.prefs, env: app.env,
    apple: app.apple, touchFirst: app.touchFirst || params.get('touch') === '1', log: app.log,
    onLeave: () => viewer.ended({ title: 'Disconnected', body: 'This was the demo. Reload the page to start it again.' }, { canReconnect: false }),
    onReconnect: () => location.reload(),
    onHome: () => location.reload(),
  });
  app.viewer = viewer;
  app.demoSession = session;
  viewer.mount();
  if (params.get('sound') === 'blocked') viewer.soundBlocked();
}

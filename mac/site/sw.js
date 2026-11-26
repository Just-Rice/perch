// The service worker that lets Perch be added to a phone's home screen and opened like an app (js/platform.js
// registers it). It caches nothing: every page and file still comes fresh from the website, so an update is never
// held back. It only answers when a page can't be loaded at all, with a short note instead of the browser's own
// error page.
const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Perch: offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;
background:#0d1015;color:#e8ebf0;text-align:center;padding:24px;box-sizing:border-box}a{color:#2dd4bf}</style></head>
<body><main><h1>You're offline</h1><p>Perch needs the internet to reach your computer.</p>
<p><a href="">Try again</a></p></main></body></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() =>
    new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

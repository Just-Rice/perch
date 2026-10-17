// The connect page's first script. It has no imports on purpose, so nothing else runs before this check.
//
// Perch must never run inside another website's frame: that site could lay invisible buttons over ours, or watch and
// steer the session. GitHub Pages can't send a frame-blocking header (and CSP frame-ancestors doesn't work from a
// <meta> tag), so the page checks for itself:
//   - every frame around this page must be readable from here, which only same-origin ones are (our own about:blank
//     and blob: tabs, made by js/blank.js or by About:Blank Lab on just-rice.github.io, are);
//   - a sandboxed frame without allow-same-origin has the opaque origin 'null' and is refused too.
// The rest of the page (js/ui/app.js) is only loaded once the check passes.

function allowedHere() {
  if (window.origin === 'null') return false;
  try {
    let w = window;
    while (w !== w.top) {
      w = w.parent;
      // Both of these throw a SecurityError for a window on another origin.
      if (typeof w.location.href !== 'string' || w.origin !== window.origin) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function refuse() {
  const real = location.hostname === 'just-rice.github.io';
  const url = real ? 'https://just-rice.github.io/perch/connect.html' : location.href.split('#')[0];
  const p = document.getElementById('bootText');
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = real ? 'just-rice.github.io/perch' : url;
  p.replaceChildren("Perch can't run inside another website. Open it directly: ", link);
  document.getElementById('boot').classList.add('refused');
  document.title = 'Perch: open it directly';
}

if (allowedHere()) {
  import('./ui/app.js').then(m => m.start()).catch(e => {
    const p = document.getElementById('bootText');
    p.textContent = "Perch couldn't start in this browser. Try reloading the page, or a recent Safari, Chrome, Edge or Firefox.";
    console.error(e);
  });
} else {
  refuse();
}

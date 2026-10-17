// Opens Perch inside an about:blank tab, the same way About:Blank Lab does: an empty tab whose address bar says
// about:blank, holding a full-size frame of the real page. The blank tab belongs to this site, so passkeys, sound and
// full screen keep working in the frame; connect.html refuses to run inside any other site's frame.
export function openInBlankTab(target = new URL('connect.html', location.href).href, title = 'Perch') {
  const tab = window.open('about:blank', '_blank');
  if (!tab) return { ok: false, reason: 'blocked' };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = new URL('css/blank.css', location.href).href;
  const allow = 'fullscreen; autoplay; publickey-credentials-get; publickey-credentials-create; ' +
    'clipboard-read; clipboard-write; keyboard-map; screen-wake-lock';
  try {
    tab.document.open();
    tab.document.write('<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<title>${esc(title)}</title><link rel="stylesheet" href="${esc(css)}"></head>` +
      `<body><iframe src="${esc(target)}" allow="${allow}" allowfullscreen></iframe></body></html>`);
    tab.document.close();
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  return { ok: true };
}

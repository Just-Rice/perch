// Opens Perch inside an about:blank tab, the same way About:Blank Lab does: an empty tab whose address bar says
// about:blank, holding a full-size frame of the real page. The blank tab belongs to this site, so passkeys, sound and
// full screen keep working in the frame; connect.html refuses to run inside any other site's frame.
//
// The tab is filled with DOM calls, not document.open()/write(): document.open() gives the document the opener's
// address (HTML spec, "document open steps"), so the tab would stop being about:blank.
export function openInBlankTab(target = new URL('connect.html', location.href).href, title = 'Perch') {
  const tab = window.open('about:blank', '_blank');
  if (!tab) return { ok: false, reason: 'blocked' };
  const allow = 'fullscreen; autoplay; publickey-credentials-get; publickey-credentials-create; ' +
    'clipboard-read; clipboard-write; keyboard-map; screen-wake-lock';
  try {
    const doc = tab.document;
    const head = doc.head || doc.documentElement.appendChild(doc.createElement('head'));
    const body = doc.body || doc.documentElement.appendChild(doc.createElement('body'));
    doc.title = title;
    const viewport = doc.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    const css = doc.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('css/blank.css', location.href).href;
    head.append(viewport, css);
    const frame = doc.createElement('iframe');
    frame.setAttribute('allow', allow);
    frame.allowFullscreen = true;
    frame.title = title;
    frame.src = target;
    body.append(frame);
    frame.focus();
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  return { ok: true };
}

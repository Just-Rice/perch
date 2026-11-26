// Sites this Mac accepts sign-ins from. The official site is built in; the owner can add others (their own copy of
// the Perch website). Only this page can change the list, and this page only opens on the Mac itself.
import { $, h, setText, show, say, busy } from '../lib/dom.js';
import { confirmInline } from '../lib/confirm.js';

const host = origin => { try { return new URL(origin).host; } catch { return origin; } };

export function sites(ctx) {
  const error = $('sitesError');
  const ok = $('sitesOk');
  const url = $('siteUrl');
  url.addEventListener('input', () => say(error, ''));

  $('siteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say(ok, '');
    if (!url.value.trim()) { say(error, 'Type the address of the Perch page on that site.'); url.focus(); return; }
    const added = await busy($('siteAddBtn'), error, () => ctx.post('siteAdd', { url: url.value.trim() }));
    if (!added) return;
    url.value = '';
    say(ok, `Added ${host(added.origin)}. Pair your devices for it in step 3.`);
  });

  let shown = '';
  function render(st) {
    const list = st.sites ?? [];
    const key = JSON.stringify(list);
    if (key !== shown) {
      shown = key;
      $('sitesList').replaceChildren(...list.map(site => {
        const row = h('li', { class: 'site-row' },
          h('span', { class: 'site-name' }, h('b', {}, host(site.origin)),
            h('span', { class: 'muted small' }, (site.official ? ' · the official Perch site' : site.builtIn ? ' · built in' : ` · ${site.url}`)
              + (site.primary && list.length > 1 ? ' · new pairing links use it' : ''))));
        if (!site.builtIn) {
          const remove = h('button', { type: 'button', class: 'btn danger-quiet small' }, 'Remove');
          remove.addEventListener('click', () => confirmInline(remove, {
            text: `Stop accepting sign-ins from ${host(site.origin)}? Devices paired on that site are removed too.`,
            yes: 'Remove', danger: true, container: row,
            onYes: async () => { await ctx.post('siteRemove', { origin: site.origin }); say(ok, ''); },
          }));
          row.append(remove);
        }
        return row;
      }));
    }
    // Step 3 asks which site a new device is for, once there is more than one.
    const pick = $('pairSite');
    const want = list.map(x => x.origin).join('|');
    if (pick.dataset.sites !== want) {
      const before = pick.value;
      pick.dataset.sites = want;
      pick.replaceChildren(...list.map(x => h('option', { value: x.origin }, host(x.origin))));
      // New devices are paired for the default site unless another was just chosen.
      const primary = list.find(x => x.primary)?.origin;
      if (before && list.some(x => x.origin === before)) pick.value = before;
      else if (primary) pick.value = primary;
    }
    show($('pairSiteLabel'), list.length > 1);
  }

  return { render };
}

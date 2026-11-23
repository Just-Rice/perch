// Front page: the embers, icons, the copy button, the about:blank button and the header's line once scrolled.
import { openInBlankTab } from './blank.js';
import { startEmbers } from './shared/ember.js';
import { fillIcons } from './ui/icons.js';

const $ = id => document.getElementById(id);

startEmbers($('embers'), { calm: () => document.querySelector('.hero > div') });
fillIcons(document);

const header = document.querySelector('header.site');
const onScroll = () => header?.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

$('copyCmd').addEventListener('click', async () => {
  const text = $('installCmd').textContent;
  try {
    await navigator.clipboard.writeText(text);
    $('copyStatus').textContent = 'Copied. Paste it into PowerShell and press Enter.';
  } catch {
    const r = document.createRange();
    r.selectNodeContents($('installCmd'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    $('copyStatus').textContent = 'Selected: press Ctrl+C (or ⌘C) to copy it.';
  }
});

$('openBlank').addEventListener('click', () => {
  const r = openInBlankTab();
  $('blankStatus').textContent = r.ok ? 'Opened Roost in a new about:blank tab.'
    : r.reason === 'blocked' ? 'Your browser blocked the new tab. Allow pop-ups for this page and try again.'
    : `Couldn't open the tab (${r.reason}).`;
});

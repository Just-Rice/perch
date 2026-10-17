// Front page: the copy button and the about:blank button.
import { openInBlankTab } from './blank.js';

const $ = id => document.getElementById(id);

$('copyCmd').addEventListener('click', async () => {
  const text = $('installCmd').textContent;
  try {
    await navigator.clipboard.writeText(text);
    $('copyStatus').textContent = 'Copied. Paste it into Terminal and press Return.';
  } catch {
    const r = document.createRange();
    r.selectNodeContents($('installCmd'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    $('copyStatus').textContent = 'Selected: press ⌘C to copy it.';
  }
});

$('openBlank').addEventListener('click', () => {
  const r = openInBlankTab();
  $('blankStatus').textContent = r.ok ? 'Opened in a new about:blank tab.'
    : r.reason === 'blocked' ? 'Your browser blocked the new tab. Allow pop-ups for this page and try again.'
    : `Couldn't open the tab (${r.reason}).`;
});

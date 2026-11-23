// Recent activity: sign-ins, failed attempts, pairing and setup changes, newest first.
import { $, h, show, setText } from '../lib/dom.js';
import { ago, dayAndTime, toMs } from '../lib/time.js';

const FIRST = 8;

// Failures and lock-outs stand out in red, sign-ins and pairing in green; everything else is neutral. It goes by the
// entry's kind (Perch uses failure, lockout, sign-in, pairing, session, device, settings), not by its words, since
// a Mac or device name could contain anything ("amber-badger-1234").
export function toneOf(item) {
  const kind = String(item.kind ?? '').toLowerCase();
  if (/fail|lock|denied|refus/.test(kind)) return 'bad';
  if (/sign-?in|pair|connect/.test(kind)) {
    // A pairing link burnt by wrong guesses is a pairing entry too, but not a good one.
    return /wrong|fail/i.test(item.text ?? '') ? 'bad' : 'good';
  }
  return 'neutral';
}

export function activity() {
  const list = $('activityList');
  const more = $('activityMoreBtn');
  let expanded = false;
  let last = '';
  let lastState = null;

  more.addEventListener('click', () => { expanded = true; render(lastState); list.children[FIRST]?.focus(); });

  function render(st) {
    if (!st) return;
    lastState = st;
    const items = Array.isArray(st.activity) ? st.activity : [];
    const shown = expanded ? items : items.slice(0, FIRST);
    // Rebuild only when something changed (including the minute, so "5 minutes ago" stays right).
    const key = JSON.stringify(shown) + Math.floor(Date.now() / 60000);
    if (key !== last) {
      last = key;
      list.replaceChildren(...shown.map((a) => {
        const ms = toMs(a.at);
        return h('li', { 'data-tone': toneOf(a), tabindex: -1 },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          h('span', { class: 'what' }, a.text ?? ''),
          h('time', { datetime: Number.isNaN(ms) ? null : new Date(ms).toISOString(), title: dayAndTime(ms) }, ago(ms)));
      }));
    }
    show($('activityEmpty'), items.length === 0);
    show(more, !expanded && items.length > FIRST);
    setText(more, `Show ${items.length - FIRST} more`);
  }

  return { render };
}

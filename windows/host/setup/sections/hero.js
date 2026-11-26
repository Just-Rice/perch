// The status hero at the top of Home, and the state pill in the sidebar: your PC's name (and renaming it), what Roost
// is doing in a word and a line, and the ring around the PC that shows it at a glance (its colour is the state; while
// setting up, how much of it is done).
import { $, setText, show, say, busy } from '../lib/dom.js';
import { normalizeMacName, CUSTOM_MAC_NAME_RE } from '../lib/names.js';
import { setupSteps } from './home.js';

const PILL = {
  starting: ['Starting…', 'neutral'],
  ready: ['Ready', 'good'],
  'needs-setup': ['Needs setup', 'warn'],
  paused: ['Paused', 'warn'],
  offline: ['Offline – can\'t reach the internet', 'bad'],
  error: ['Something went wrong', 'bad'],
};
const WORD = { connected: 'Connected', offline: 'Offline' };

export function pillFor(st) {
  if (st.state === 'connected') return [`Connected to ${st.session?.viewer || 'a device'}`, 'live'];
  return PILL[st.state] ?? [st.state || 'Unknown', 'neutral'];
}

// The host's line about the state, without repeating the word the hero already shows ("Paused: nobody can connect"
// -> "Nobody can connect").
export function stateLine(st, word) {
  const text = String(st.stateText ?? '').trim();
  if (!text || st.state === 'connected') return '';
  const rest = text.replace(new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:–-]\\s*`, 'i'), '');
  if (rest.replace(/\.$/, '').toLowerCase() === word.toLowerCase()) return '';
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function hero(ctx) {
  const pill = $('statePill');
  const card = $('hero');
  const ring = $('heroRing');
  const input = $('nameNew'), error = $('nameError');
  input.addEventListener('input', () => {
    say(error, '');
    const name = normalizeMacName(input.value);
    input.setCustomValidity(name && !CUSTOM_MAC_NAME_RE.test(name) ? 'not a name' : '');
  });
  const done = () => { input.value = ''; $('nameBox').open = false; $('pcName').focus(); };
  $('nameBox').addEventListener('toggle', () => { if ($('nameBox').open) input.focus(); });
  $('nameBox').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); $('nameBox').open = false; $('nameBox').querySelector('summary').focus(); }
  });
  $('nameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = normalizeMacName(input.value);
    if (!CUSTOM_MAC_NAME_RE.test(name)) {
      say(error, 'Use 4 to 40 letters or numbers, with single hyphens between words, like jordan-desktop.');
      input.focus();
      return;
    }
    if (await busy($('nameSaveBtn'), error, async () => { await ctx.post('customMacName', { name }); return true; })) done();
  });
  $('nameRandomBtn').addEventListener('click', async () => {
    if (await busy($('nameRandomBtn'), error, async () => { await ctx.post('newMacName'); return true; })) done();
  });

  return {
    render(st) {
      const [text, tone] = pillFor(st);
      setText($('statePillText'), text);
      pill.dataset.tone = tone;
      card.dataset.tone = tone;
      const word = WORD[st.state] ?? text;
      setText($('heroState'), word);
      setText($('stateText'), stateLine(st, word));
      // The ring: full once set up; while setting up, the share of the steps that are done.
      const steps = setupSteps(st).filter(s => !s.hidden);
      const share = st.state === 'needs-setup' ? Math.max(0.04, steps.filter(s => s.done).length / steps.length) : 1;
      ring.style.setProperty('--p', String(Math.round(share * 100)));
      setText($('pcName'), st.macName);
      setText($('sidePcName'), st.macName);
      setText($('headVersion'), st.version ? `Roost ${st.version}` : '');
      show($('testBadge'), st.test === true);
      document.title = st.macName ? `${st.macName} · Roost Control Center` : 'Roost Control Center';
    },
  };
}

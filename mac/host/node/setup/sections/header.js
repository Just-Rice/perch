// The top of the page: this Mac's name, the overall state pill and the version.
import { $, setText, show, say, busy } from '../lib/dom.js';
import { normalizeMacName, CUSTOM_MAC_NAME_RE } from '../lib/names.js';

const PILL = {
  starting: ['Starting…', 'neutral'],
  ready: ['Ready', 'good'],
  'needs-setup': ['Needs setup', 'warn'],
  paused: ['Paused', 'warn'],
  offline: ['Offline – can\'t reach the internet', 'bad'],
  error: ['Something went wrong', 'bad'],
};

export function pillFor(st) {
  if (st.state === 'connected') return [`Connected to ${st.session?.viewer || 'a device'}`, 'live'];
  return PILL[st.state] ?? [st.state || 'Unknown', 'neutral'];
}

export function header(ctx) {
  const pill = $('statePill');
  // Naming the Mac, right at the top: a name of the owner's own, or a new made-up one.
  const input = $('nameNew'), error = $('nameError');
  input.addEventListener('input', () => {
    say(error, '');
    const name = normalizeMacName(input.value);
    input.setCustomValidity(name && !CUSTOM_MAC_NAME_RE.test(name) ? 'not a name' : '');
  });
  const done = () => { input.value = ''; $('nameBox').open = false; $('macName').focus?.(); };
  $('nameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = normalizeMacName(input.value);
    if (!CUSTOM_MAC_NAME_RE.test(name)) {
      say(error, 'Use 4 to 40 letters or numbers, with single hyphens between words, like jordan-macbook.');
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
      setText($('macName'), st.macName);
      setText($('headVersion'), st.version ? `version ${st.version}` : '');
      // The plain-language line from Perch, unless it would only repeat the pill.
      const extra = st.stateText && st.stateText.replace(/\.$/, '') !== text ? st.stateText : '';
      setText($('stateText'), extra);
      show($('testBadge'), st.test === true);
      document.title = st.macName ? `Perch Setup · ${st.macName}` : 'Perch Setup';
    },
  };
}

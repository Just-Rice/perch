// The top of the page: this Mac's name, the overall state pill and the version.
import { $, setText, show } from '../lib/dom.js';

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

export function header() {
  const pill = $('statePill');
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

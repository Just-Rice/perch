// The feedback page (feedback.html): a short form sent to the owner's feedback box (feedback/), after Cloudflare's
// "not a robot" check (Turnstile). Where the person came from (the viewer, or Setup) arrives in the address's #, as
// `from`, `v` (Perch's version) and `os`; it is shown on the page and sent only if they leave it in.
//
// Tests on this computer only (localhost): ?test=1&endpoint=<url> sends there instead, and ?turnstile=skip leaves the
// robot check out (the test box accepts any token).
import { startCipher } from './shared/cipher.js';
import { FEEDBACK_URL, TURNSTILE_SITE_KEY } from './shared/proto.js';

const $ = (id) => document.getElementById(id);
startCipher($('cipher'), { calm: () => document.querySelector('main') });

const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const params = new URLSearchParams(location.search);
const test = local && params.get('test') === '1';
const endpoint = (test && params.get('endpoint')) || FEEDBACK_URL;
const skipRobotCheck = test && params.get('turnstile') === 'skip';

// Where they came from, if Perch sent them here.
const hash = new URLSearchParams(location.hash.slice(1));
const context = {
  source: ['viewer', 'setup'].includes(hash.get('from')) ? hash.get('from') : 'site',
  version: /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,20})?$/.test(hash.get('v') ?? '') ? hash.get('v') : null,
  os: ['mac', 'windows', 'linux'].includes(hash.get('os')) ? hash.get('os') : null,
};
let sendContext = context.source !== 'site' || !!context.version;
const OS_WORDS = { mac: 'a Mac', windows: 'a Windows PC', linux: 'a Linux computer' };
function showContext() {
  const el = $('fbContext');
  el.replaceChildren();
  if (!(context.source !== 'site' || context.version)) { el.hidden = true; return; }
  el.hidden = false;
  if (!sendContext) { el.textContent = 'Perch’s version and the kind of computer won’t be sent.'; return; }
  const parts = [context.source === 'viewer' ? 'Sent from Perch’s viewer' : 'Sent from Perch’s Setup'];
  if (context.version) parts.push(`Perch ${context.version}`);
  if (context.os) parts.push(`controlling ${OS_WORDS[context.os]}`);
  el.append(`${parts.join(', ')}. `);
  const leave = document.createElement('button');
  leave.type = 'button';
  leave.className = 'btn quiet small';
  leave.textContent = 'Don’t include this';
  leave.addEventListener('click', () => { sendContext = false; showContext(); });
  el.append(leave);
}
showContext();

// The message counter.
const message = $('fbMessage');
const count = () => { $('fbCount').textContent = `${message.value.length} / 4000`; };
message.addEventListener('input', count);
count();

// The robot check: Cloudflare's script, drawn here once it has loaded (explicit rendering: no inline script).
let robotToken = skipRobotCheck ? 'test' : null;
let widget = null;
function startRobotCheck() {
  if (skipRobotCheck) return;
  if (!TURNSTILE_SITE_KEY) {
    say('bad', 'The feedback box isn’t open yet. Until it is, you can open an issue on GitHub.');
    $('fbSend').disabled = true;
    return;
  }
  window.perchTurnstileReady = () => {
    widget = window.turnstile.render('#fbTurnstile', {
      sitekey: TURNSTILE_SITE_KEY, action: 'feedback', appearance: 'interaction-only',
      callback: (t) => { robotToken = t; },
      'expired-callback': () => { robotToken = null; },
      'error-callback': () => { robotToken = null; },
    });
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=perchTurnstileReady';
  s.async = true;
  document.head.append(s);
}
startRobotCheck();

function say(kind, text) {
  $('fbDone').hidden = kind !== 'ok';
  $('fbError').hidden = kind !== 'bad';
  if (kind === 'bad') $('fbError').textContent = text;
}

$('feedbackForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = message.value.trim();
  if (text.length < 3) { say('bad', 'Write a few words first.'); message.focus(); return; }
  if (!robotToken) { say('bad', 'One moment: Cloudflare is still checking you’re not a robot. Try again in a few seconds.'); return; }
  const button = $('fbSend');
  button.disabled = true;
  say(null);
  const body = {
    kind: document.querySelector('input[name=kind]:checked')?.value ?? 'other',
    message: text,
    contact: $('fbContact').value.trim() || undefined,
    source: context.source,
    ...(sendContext && context.version ? { version: context.version } : {}),
    ...(sendContext && context.os ? { os: context.os } : {}),
    turnstile: robotToken,
    website: $('fbWebsite').value,
  };
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (r.status === 201) {
      say('ok');
      message.value = '';
      $('fbContact').value = '';
      count();
      return;
    }
    say('bad', out.detail || 'That didn’t send. Try again in a minute.');
  } catch {
    say('bad', 'That didn’t send: this device couldn’t reach the feedback box. Check you’re online and try again.');
  } finally {
    button.disabled = false;
    // A Turnstile token works once: get a fresh one for another message.
    if (!skipRobotCheck) { robotToken = null; if (widget !== null) window.turnstile?.reset(widget); }
  }
});

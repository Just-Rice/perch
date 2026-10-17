// Everything the Mac can say "no" with, and everything that can go wrong on the way, in plain words.
// Each function returns {title, body, wait, action}:
//   wait   — seconds before trying again makes sense (shown as a countdown), or 0;
//   action — what the main button does: 'retry' (connect again), 'reload' (this page is out of date),
//            'home' (back to the start), 'code' (type another code), 'password' (fix the password).
// Reasons come from docs/PROTOCOL.md (refuse, denied, bye, error). Unknown reasons still get a sensible message.

const setupHint = "Perch's Setup on the Mac (Perch menu › Open Setup…)";

// The protocol doesn't say what unit retryAfter is in. Seconds is the web's habit (HTTP Retry-After) and what this page
// assumes, but no Perch lock lasts longer than an hour, so anything above 3600 must be milliseconds.
export function retryAfterSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n > 3600 ? n / 1000 : n);
}

export function formatWait(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  if (s <= 0) return 'now';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s < 60) return plural(s, 'second');
  if (s < 3600) {
    const m = Math.floor(s / 60), r = s % 60;
    return r ? `${plural(m, 'minute')} ${plural(r, 'second')}` : plural(m, 'minute');
  }
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${plural(h, 'hour')} ${plural(m, 'minute')}` : plural(h, 'hour');
}

const msg = (title, body, action = 'retry', wait = 0) => ({ title, body, action, wait });

const LOCKED_OUT = wait => msg('Too many wrong tries',
  'To keep your Mac safe, signing in is paused for a while. This happens after five wrong codes, passwords or ' +
  'passkeys in a row.', 'retry', wait || 60);

// The Mac turned the connection down before any sign-in started ({t:"refuse"}).
export function refuseMessage(reason, { retryAfter, route } = {}) {
  const wait = retryAfterSeconds(retryAfter);
  switch (reason) {
    case 'version':
      return msg('This page needs a refresh',
        'Your Mac runs a newer Perch than this page knows about. Reload the page to get the latest version.', 'reload');
    case 'busy':
      return msg('Your Mac is busy',
        'Other sign-ins are going on at the Mac right now. Try again in a minute.', 'retry', wait);
    case 'paused':
      return msg('Perch is paused on your Mac',
        'Someone paused Perch from the menu bar on the Mac. Resume it there, then try again.', 'retry', wait);
    case 'locked-out':
      return LOCKED_OUT(wait);
    case 'backup-off':
      return msg('Backup sign-in is off',
        `That Mac only accepts passkeys right now. Sign in with your passkey, or turn on backup sign-in in ${setupHint}.`,
        'home');
    case 'not-set-up':
      return msg("Perch isn't set up on that Mac yet",
        `Finish ${setupHint} first, then come back here.`, 'home');
    case 'rate':
      return msg('Slow down a little',
        'Your Mac got a lot of sign-in requests at once. Wait a moment and try again.', 'retry', wait || 10);
    default:
      return msg("Your Mac didn't accept the connection",
        `It said "${String(reason || 'no reason')}". Try again, or check Perch on the Mac.`, route === 'pair' ? 'home' : 'retry', wait);
  }
}

// A sign-in step failed ({t:"denied"}). `final` false means the session is still open and the user can try again
// right here (another code); true means this connection is over.
export function deniedMessage(reason, { retryAfter, final = true, route } = {}) {
  const wait = retryAfterSeconds(retryAfter);
  switch (reason) {
    case 'code': case 'wrong-code': case 'totp': case 'bad-code':
      return msg("That code didn't work",
        'Check you picked the code for Perch in your authenticator app, and type the newest one.', final ? 'retry' : 'code', wait);
    case 'code-used': case 'reused': case 'replay':
      return msg('That code was already used',
        'Wait for your authenticator app to show a new code, then type that one.', final ? 'retry' : 'code', wait);
    case 'locked-out': case 'locked':
      return LOCKED_OUT(wait);
    case 'passkey': case 'bad-passkey': case 'assertion': case 'bad-assertion': case 'credential':
    case 'unknown-credential': case 'unknown-device': case 'counter':
      return msg("Your Mac didn't accept that passkey",
        `It may have been removed from the Mac, or belong to another Mac. If this keeps happening, pair this device again from ${setupHint}.`,
        'retry', wait);
    case 'password': case 'wrong-password': case 'opaque': case 'backup':
      return msg('Wrong Mac name or password',
        'Check the Mac name and the backup password you chose in Setup, then try again.', 'password', wait);
    case 'proof': case 'bad-proof': case 'binding': case 'bind':
      return msg("Couldn't confirm the connection",
        "Your Mac and this page didn't agree on the connection details, so Perch stopped to be safe. Try again; if it " +
        'keeps happening, try another network.', 'retry', wait);
    case 'expired': case 'pair-expired': case 'link-expired':
      return msg('This pairing link has expired',
        `Pairing links work for 10 minutes. Make a new one in ${setupHint}.`, 'home');
    case 'used': case 'pair-used': case 'link-used': case 'burnt': case 'pair-burnt':
      return msg('This pairing link was already used',
        `Each pairing link works once, on one device. Make a new one in ${setupHint}.`, 'home');
    case 'pair': case 'pairing': case 'unknown-pair': case 'bad-link':
      return msg("This pairing link doesn't work",
        `Make a new one in ${setupHint} and open it again.`, 'home');
    case 'registration': case 'register': case 'bad-registration':
      return msg("Your Mac couldn't save the passkey",
        `Make a new pairing link in ${setupHint} and try again.`, 'home');
    case 'exists': case 'duplicate': case 'already-paired':
      return msg('This device is already paired',
        'Go back to the start and sign in with the passkey you already have.', 'home');
    case 'timeout': case 'too-slow':
      return msg('Signing in took too long',
        'For safety, each sign-in has to finish within 2 minutes. Try again.', route === 'pair' ? 'home' : 'retry', wait);
    case 'origin': case 'cross-origin':
      return msg('This page is in the wrong place',
        'Your Mac only accepts sign-ins made on just-rice.github.io/perch, and not from inside another website.', 'home');
    case 'protocol':
      return msg("This page and your Mac didn't understand each other",
        'Reload the page to get the latest version. If it keeps happening, update Perch on the Mac (Perch menu › Check ' +
        'for Updates).', 'reload');
    case 'error':
      return msg('Something went wrong on your Mac',
        'Perch on the Mac ran into a problem while you were signing in. Try again.', 'retry', wait);
    default:
      return msg("Your Mac didn't let you in",
        `It said "${String(reason || 'no reason')}". Try again.`, final ? 'retry' : 'code', wait);
  }
}

// The Mac ended a running session ({t:"bye"}).
export function byeMessage(reason) {
  switch (reason) {
    case 'signed-in-elsewhere':
      return msg('Signed in somewhere else',
        'Your Mac is now being used from another device, so this one was disconnected. Only one device can use the Mac at a time.');
    case 'paused':
      return msg('Perch was paused',
        'Someone paused Perch from the menu bar on the Mac. Once it is resumed you can reconnect.');
    case 'quit':
      return msg('Perch was closed on your Mac', 'Open Perch on the Mac again, then reconnect.');
    case 'idle':
      return msg('Disconnected to be safe', 'Nobody used the Mac from here for a long while, so Perch ended the session.');
    case 'removed':
      return msg('This device was removed',
        `It can't sign in to this Mac any more. To use it again, pair it from ${setupHint}.`, 'home');
    case 'disconnected':
      return msg('Your Mac ended the session', 'Someone disconnected this device from the menu bar on the Mac.');
    default:
      return msg('Disconnected', 'The session with your Mac ended.');
  }
}

// Problems the Mac reports during a session ({t:"error"}).
export function errorMessage(code, text) {
  switch (code) {
    case 'no-screen-permission':
      return msg("Your Mac hasn't allowed screen recording",
        'On the Mac, open System Settings › Privacy & Security › Screen & System Audio Recording, turn on Perch, then reconnect.');
    case 'capture-failed':
      return msg("Your Mac couldn't share its screen",
        'Try reconnecting. If it keeps happening, quit Perch on the Mac and open it again.');
    default:
      return msg('Something went wrong on your Mac', text ? String(text).slice(0, 200) : 'Try reconnecting.');
  }
}

// Problems found on this side, by PerchError kind (ui/connection.js).
export function failureMessage(kind, { route, detail } = {}) {
  switch (kind) {
    case 'timeout':
      return route === 'backup'
        ? msg('No Mac answered to that name',
          'Check the Mac name, and that the Mac is on, awake and running Perch with backup sign-in turned on.', 'password')
        : msg("Your Mac didn't answer", "Check it's on, awake and running Perch.");
    case 'brokers':
      return msg("Couldn't reach the internet",
        'Perch uses free public message services to find your Mac, and none of them could be reached. Check this device ' +
        'is online. Some school and work networks block them.');
    case 'webrtc':
      return msg("Couldn't connect to your Mac",
        'Your Mac answered, but a direct connection couldn\'t be made. Very strict networks (some schools, workplaces ' +
        'and mobile carriers) block it. Try another network, such as your phone\'s hotspot.');
    case 'lost':
      return msg('Lost the connection to your Mac', 'The network dropped out, or the Mac went to sleep. Reconnect when it is back.');
    case 'old-mac':
      return msg('Perch on your Mac needs an update',
        "Your Mac runs an older Perch that this page can't talk to. On the Mac, choose Perch menu › Check for Updates.", 'home');
    case 'no-webauthn':
      return msg("This browser can't use passkeys",
        'Try a recent Safari, Chrome, Edge or Firefox. You can also use backup sign-in, if it is turned on for your Mac.', 'home');
    case 'not-perch-passkey':
      return msg("That passkey isn't for Perch",
        'Pick the passkey called "Perch · <your Mac\'s name>". If you have none, pair this device from Setup on the Mac first.', 'home');
    case 'no-passkey':
      return msg('No passkey was used',
        'The passkey request was closed or timed out. If this device has no Perch passkey yet, pair it from Setup on the Mac first.', 'home');
    case 'passkey-failed':
      return msg("The passkey didn't work", detail ? String(detail).slice(0, 200) : 'Try again.');
    case 'bad-link':
      return msg("This pairing link doesn't work",
        `Part of it is missing. Make a new one in ${setupHint}, and open it on this device.`, 'home');
    case 'wrong-mac':
      return msg("That doesn't look like your Mac",
        'The Mac answered with details that don\'t match the pairing link, so Perch stopped. Make a new pairing link and try again.', 'home');
    case 'wrong-password':
      return msg('Wrong Mac name or password',
        'Check the Mac name and the backup password you chose in Setup, then try again.', 'password');
    case 'protocol':
      return msg("This page and your Mac didn't understand each other",
        'Reload the page to get the latest version, then try again.', 'reload');
    default:
      return msg('Something went wrong', detail ? `Try again. (${String(detail).slice(0, 200)})`
        : 'Try again. If it keeps happening, reload the page.');
  }
}

// Any PerchError (ui/connection.js) → the message to show. `route` is how the person was signing in.
export function messageFor(err, route) {
  switch (err?.kind) {
    case 'refuse': return refuseMessage(err.reason, { retryAfter: err.retryAfter, route });
    case 'denied': return deniedMessage(err.reason, { retryAfter: err.retryAfter, final: true, route });
    case 'bye': return byeMessage(err.reason);
    default: return failureMessage(err?.kind, { route, detail: err?.message !== err?.kind ? err?.message : '' });
  }
}

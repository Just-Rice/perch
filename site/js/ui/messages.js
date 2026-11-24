// Everything the PC can say "no" with, and everything that can go wrong on the way, in plain words.
// Each function returns {title, body, wait, action}:
//   wait   — seconds before trying again makes sense (shown as a countdown), or 0;
//   action — what the main button does: 'retry' (connect again), 'reload' (this page is out of date),
//            'home' (back to the start), 'code' (type another code), 'password' (fix the password).
// Reasons come from docs/PROTOCOL.md (refuse, denied, bye, error). Unknown reasons still get a sensible message.

const setupHint = "Roost's Control Center on the PC (right-click Roost's tray icon › Control Center)";

// The protocol doesn't say what unit retryAfter is in. Seconds is the web's habit (HTTP Retry-After) and what this page
// assumes, but no Roost lock lasts longer than an hour, so anything above 3600 must be milliseconds.
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
  'To keep your PC safe, signing in is paused for a while. This happens after five wrong codes, passwords or ' +
  'passkeys in a row.', 'retry', wait || 60);

// The PC turned the connection down before any sign-in started ({t:"refuse"}).
export function refuseMessage(reason, { retryAfter, route } = {}) {
  const wait = retryAfterSeconds(retryAfter);
  switch (reason) {
    case 'version':
      return msg('This page needs a refresh',
        'Your PC runs a newer Roost than this page knows about. Reload the page to get the latest version.', 'reload');
    case 'busy':
      return msg('Your PC is busy',
        'Other sign-ins are going on at the PC right now. Try again in a minute.', 'retry', wait);
    case 'paused':
      return msg('Roost is paused on your PC',
        'Someone paused Roost from its tray icon on the PC. Resume it there, then try again.', 'retry', wait);
    case 'locked-out':
      return LOCKED_OUT(wait);
    case 'backup-off':
      return msg('Backup sign-in is off',
        `That PC only accepts passkeys right now. Sign in with your passkey, or turn on backup sign-in in ${setupHint}.`,
        'home');
    case 'not-set-up':
      return msg("Roost isn't set up on that PC yet",
        `Finish ${setupHint} first, then come back here.`, 'home');
    case 'rate':
      return msg('Slow down a little',
        'Your PC got a lot of sign-in requests at once. Wait a moment and try again.', 'retry', wait || 10);
    default:
      return msg("Your PC didn't accept the connection",
        `It said "${String(reason || 'no reason')}". Try again, or check Roost on the PC.`, route === 'pair' ? 'home' : 'retry', wait);
  }
}

// A sign-in step failed ({t:"denied"}). `final` false means the session is still open and the user can try again
// right here (another code); true means this connection is over.
export function deniedMessage(reason, { retryAfter, final = true, route } = {}) {
  const wait = retryAfterSeconds(retryAfter);
  switch (reason) {
    case 'code': case 'wrong-code': case 'totp': case 'bad-code':
      return msg("That code didn't work",
        'Check you picked the code for Roost in your authenticator app, and type the newest one.', final ? 'retry' : 'code', wait);
    case 'code-used': case 'reused': case 'replay':
      return msg('That code was already used',
        'Wait for your authenticator app to show a new code, then type that one.', final ? 'retry' : 'code', wait);
    case 'locked-out': case 'locked':
      return LOCKED_OUT(wait);
    case 'passkey': case 'bad-passkey': case 'assertion': case 'bad-assertion': case 'credential':
    case 'unknown-credential': case 'unknown-device': case 'counter':
      return msg("Your PC didn't accept that passkey",
        `It may have been removed from the PC, or belong to another PC. If this keeps happening, pair this device again from ${setupHint}.`,
        'retry', wait);
    case 'password': case 'wrong-password': case 'opaque': case 'backup':
      return msg('Wrong PC name or password',
        'Check the PC name and the backup password you chose in the Control Center, then try again.', 'password', wait);
    case 'proof': case 'bad-proof': case 'binding': case 'bind':
      return msg("Couldn't confirm the connection",
        "Your PC and this page didn't agree on the connection details, so Roost stopped to be safe. Try again; if it " +
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
      return msg("Your PC couldn't save the passkey",
        `Make a new pairing link in ${setupHint} and try again.`, 'home');
    case 'exists': case 'duplicate': case 'already-paired':
      return msg('This device is already paired',
        'Go back to the start and sign in with the passkey you already have.', 'home');
    case 'timeout': case 'too-slow':
      return msg('Signing in took too long',
        'For safety, each sign-in has to finish within 2 minutes. Try again.', route === 'pair' ? 'home' : 'retry', wait);
    case 'origin': case 'cross-origin':
      return msg("Your PC doesn't accept sign-ins from this site",
        'It accepts them from just-rice.github.io/roost and from sites added in Roost\'s Control Center on the PC ' +
        '(Sites that can sign in), and never from inside another website.', 'home');
    case 'protocol':
      return msg("This page and your PC didn't understand each other",
        'Reload the page to get the latest version. If it keeps happening, update Roost on the PC (its Control Center ' +
        'says when an update is out).', 'reload');
    case 'error':
      return msg('Something went wrong on your PC',
        'Roost on the PC ran into a problem while you were signing in. Try again.', 'retry', wait);
    default:
      return msg("Your PC didn't let you in",
        `It said "${String(reason || 'no reason')}". Try again.`, final ? 'retry' : 'code', wait);
  }
}

// The PC ended a running session ({t:"bye"}).
export function byeMessage(reason) {
  switch (reason) {
    case 'signed-in-elsewhere':
      return msg('Signed in somewhere else',
        'Your PC is now being used from another device, so this one was disconnected. Only one device can use the PC at a time.');
    case 'paused':
      return msg('Roost was paused',
        'Someone paused Roost from its tray icon on the PC. Once it is resumed you can reconnect.');
    case 'quit':
      return msg('Roost was closed on your PC', 'Open Roost on the PC again (it\'s in the Start menu), then reconnect.');
    case 'idle':
      return msg('Disconnected to be safe', 'Nobody used the PC from here for a long while, so Roost ended the session.');
    case 'removed':
      return msg('This device was removed',
        `It can't sign in to this PC any more. To use it again, pair it from ${setupHint}.`, 'home');
    case 'disconnected':
      return msg('Your PC ended the session', 'Someone disconnected this device from Roost\'s tray icon on the PC.');
    default:
      return msg('Disconnected', 'The session with your PC ended.');
  }
}

// Problems the PC reports during a session ({t:"error"}).
export function errorMessage(code, text) {
  switch (code) {
    case 'no-screen-permission':
      return msg("Your PC can't share its screen right now",
        'Windows is showing a screen Roost isn\'t allowed to see (a sign-in or permission prompt). Turn on Control admin apps in Roost\'s Control Center, then reconnect.');
    case 'capture-failed':
      return msg("Your PC couldn't share its screen",
        'Try reconnecting. If it keeps happening, quit Roost from its tray icon on the PC and open it again.');
    default:
      return msg('Something went wrong on your PC', text ? String(text).slice(0, 200) : 'Try reconnecting.');
  }
}

// Problems found on this side, by RoostError kind (ui/connection.js).
export function failureMessage(kind, { route, detail } = {}) {
  switch (kind) {
    case 'timeout':
      return route === 'backup'
        ? msg('No PC answered to that name',
          'Check the PC name, and that the PC is on, awake and running Roost with backup sign-in turned on.', 'password')
        : msg("Your PC didn't answer", "Check it's on, awake and running Roost.");
    case 'brokers':
      return msg("Couldn't reach the internet",
        'Roost uses free public message services to find your PC, and none of them could be reached. Check this device ' +
        'is online. Some school and work networks block them.');
    case 'webrtc':
      return msg("Couldn't connect to your PC",
        'Your PC answered, but a direct connection couldn\'t be made. Very strict networks (some schools, workplaces ' +
        'and mobile carriers) block it. Try another network, such as your phone\'s hotspot.');
    case 'lost':
      return msg('Lost the connection to your PC', 'The network dropped out, or the PC went to sleep. Reconnect when it is back.');
    case 'old-mac':
      return msg('Roost on your PC needs an update',
        "Your PC runs an older Roost that this page can't talk to. Update it from the Control Center on the PC.", 'home');
    case 'no-webauthn':
      return msg("This browser can't use passkeys",
        'Try a recent Safari, Chrome, Edge or Firefox. You can also use backup sign-in, if it is turned on for your PC.', 'home');
    case 'not-roost-passkey':
      return msg("That passkey isn't for Roost",
        'Pick the passkey called "Roost · <your PC\'s name>". If you have none, pair this device from the Control Center on the PC first.', 'home');
    case 'no-passkey':
      return msg('No passkey was used',
        'The passkey request was closed or timed out. If this device has no Roost passkey yet, pair it from the Control Center on the PC first.', 'home');
    case 'passkey-failed':
      return msg("The passkey didn't work", detail ? String(detail).slice(0, 200) : 'Try again.');
    case 'bad-link':
      return msg("This pairing link doesn't work",
        `Part of it is missing. Make a new one in ${setupHint}, and open it on this device.`, 'home');
    case 'wrong-mac':
      return msg("That doesn't look like your PC",
        'The PC answered with details that don\'t match the pairing link, so Roost stopped. Make a new pairing link and try again.', 'home');
    case 'wrong-password':
      return msg('Wrong PC name or password',
        'Check the PC name and the backup password you chose in the Control Center, then try again.', 'password');
    case 'protocol':
      return msg("This page and your PC didn't understand each other",
        'Reload the page to get the latest version, then try again.', 'reload');
    default:
      return msg('Something went wrong', detail ? `Try again. (${String(detail).slice(0, 200)})`
        : 'Try again. If it keeps happening, reload the page.');
  }
}

// Any RoostError (ui/connection.js) → the message to show. `route` is how the person was signing in.
// A guest link that no longer works, however the PC said so.
const guestOver = () => msg('This guest link has stopped working',
  'It ran out or was switched off. Ask the person who sent it for a new one.', 'home');

export function messageFor(err, route) {
  if (route === 'guest') {
    const r = err?.reason;
    if ((err?.kind === 'refuse' || err?.kind === 'denied') && ['link-expired', 'bad-link', 'not-set-up'].includes(r)) return guestOver();
    if (err?.kind === 'bye' && r === 'removed') return guestOver();
    if (err?.kind === 'refuse' && r === 'busy') {
      return msg('Too many people are watching', 'This link is already being watched by as many people as it allows. Try again in a moment.', 'retry');
    }
    if (err?.kind === 'timeout') {
      return msg("The PC didn't answer", 'It may be switched off or asleep, or the link has stopped working. Ask the person who sent it.', 'retry');
    }
  }
  switch (err?.kind) {
    case 'refuse': return refuseMessage(err.reason, { retryAfter: err.retryAfter, route });
    case 'denied': return deniedMessage(err.reason, { retryAfter: err.retryAfter, final: true, route });
    case 'bye': return byeMessage(err.reason);
    default: return failureMessage(err?.kind, { route, detail: err?.message !== err?.kind ? err?.message : '' });
  }
}

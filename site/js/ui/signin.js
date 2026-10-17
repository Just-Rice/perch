// The three ways to sign in, step by step over the control channel (docs/PROTOCOL.md, "Control channel: signing in").
//
//   passkey: hi → assert (WebAuthn over bind) → totp → code → ready
//   backup:  hi → opaque1 → opaque2 → opaque3 (proof over bind) → totp → code → ready
//   pair:    hi → pair1 (proof over bind) → pair-options → pair-cred (new passkey) → totp → code → paired → ready
//
// `ui` provides the screens (ui/screens.js): askPasskey, askCreate, askCode and stage. Every wait on the person goes
// through conn.guard(), so if the Mac gives up meanwhile (2-minute limit, a bye) the flow stops at once.
import { PerchError } from './connection.js';
import { getAssertion, createPasskey, webauthnErrorKind } from './passkey.js';
import { deniedMessage } from './messages.js';
import { bindProof } from '../shared/bind.js';
import { toB64url, fromB64url, concat } from '../shared/bytes.js';

const REPLY_MS = 30000; // how long the Mac may take to answer one sign-in message

let opaqueModule = null;
// The password library is big (WebAssembly), so it is only fetched when backup sign-in is actually used.
export function loadOpaque() {
  opaqueModule ||= import('../vendor/opaque/index.js').then(async m => { await m.ready; return m; });
  opaqueModule.catch(() => { opaqueModule = null; });
  return opaqueModule;
}

const deniedError = m => new PerchError('denied', { reason: m.reason, retryAfter: m.retryAfter, final: m.final !== false });

// ctx: {route, rpId, label, credentialId?, hostId?, sigKey?, password?, pair?, onPaired(msg), onHi(hi)}
// Resolves to {hi, ready}.
export async function signIn(conn, ctx, ui) {
  const hi = await conn.open();
  if (hi.route && hi.route !== ctx.route) throw new PerchError('protocol', { message: `Mac answered for ${hi.route}` });
  ctx.onHi?.(hi);

  if (ctx.route === 'passkey') {
    const cred = await passkeyStep(conn, ctx, ui, hi);
    conn.send({ t: 'assert', response: cred.json });
  } else if (ctx.route === 'backup') {
    await backupSteps(conn, ctx, ui);
  } else if (ctx.route === 'pair') {
    await pairSteps(conn, ctx, ui, hi);
  } else {
    throw new PerchError('protocol', { message: 'unknown route' });
  }

  ui.stage('verifying');
  let m = await conn.next(['totp', 'denied'], REPLY_MS);
  if (m.t === 'denied') throw deniedError(m);

  // The 6-digit code. A wrong code (final: false) keeps the session open: just ask again.
  let error = null;
  for (;;) {
    const code = await conn.guard(ui.askCode({ name: hi.name, error }));
    conn.send({ t: 'code', code });
    ui.stage('code-sent');
    m = await conn.next(['ready', 'paired', 'denied'], REPLY_MS);
    if (m.t === 'paired') {
      ctx.onPaired?.(m);
      m = await conn.next(['ready', 'denied'], REPLY_MS);
    }
    if (m.t === 'ready') return { hi, ready: m };
    if (m.final !== false) throw deniedError(m);
    error = deniedMessage(m.reason, { retryAfter: m.retryAfter, final: false, route: ctx.route });
  }
}

// Ask for the passkey right away when the browser still counts the person's last tap (Chrome allows that for a few
// seconds); Safari and anything else that refuses gets a big "Continue with passkey" button, and the request is made
// inside that tap.
async function passkeyStep(conn, ctx, ui, hi) {
  const run = () => getAssertion({
    challenge: conn.bind,
    rpId: ctx.rpId,
    credentialIds: ctx.credentialId ? [ctx.credentialId] : [],
  });
  let error = null;
  if (globalThis.navigator?.userActivation?.isActive && !ctx.alwaysTap) {
    ui.stage('passkey');
    try {
      return await conn.guard(run());
    } catch (e) {
      if (e instanceof PerchError) throw e;
      if (webauthnErrorKind(e) === 'wrong-site') throw new PerchError('denied', { reason: 'origin', final: true });
      // Fall through to the button: most often the browser just wanted a fresh tap.
    }
  }
  for (;;) {
    try {
      return await conn.guard(ui.askPasskey({ name: hi.name, error, run }));
    } catch (e) {
      if (e instanceof PerchError) throw e;
      const kind = webauthnErrorKind(e);
      if (kind === 'wrong-site') throw new PerchError('denied', { reason: 'origin', final: true });
      error = kind === 'cancelled'
        ? 'The passkey request was closed before it finished. Tap the button to try again.'
        : `The passkey didn't work (${e.name || 'error'}). Tap the button to try again.`;
    }
  }
}

async function backupSteps(conn, ctx, ui) {
  ui.stage('password');
  const opaque = await loadOpaque();
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: ctx.password });
  conn.send({ t: 'opaque1', req: startLoginRequest });
  const m = await conn.next(['opaque2', 'denied'], REPLY_MS);
  if (m.t === 'denied') throw deniedError(m);
  let fin;
  try {
    fin = opaque.client.finishLogin({ clientLoginState, loginResponse: m.res, password: ctx.password });
  } catch {
    fin = undefined;
  }
  if (!fin) {
    // A wrong password can't be told apart from a wrong Mac name; the Mac counts it as a failed try either way.
    conn.send({ t: 'opaque-fail' });
    throw new PerchError('wrong-password');
  }
  const proof = await bindProof(fromB64url(fin.sessionKey), 'backup', conn.bind);
  conn.send({ t: 'opaque3', fin: fin.finishLoginRequest, proof: toB64url(proof) });
}

async function pairSteps(conn, ctx, ui, hi) {
  const { pair } = ctx;
  const proof = await bindProof(pair.pairSecret, 'pair', conn.bind);
  conn.send({ t: 'pair1', pairId: toB64url(pair.pairId), proof: toB64url(proof) });
  const m = await conn.next(['pair-options', 'denied'], REPLY_MS);
  if (m.t === 'denied') throw deniedError(m);
  const o = m.options;
  // The new passkey must be for this connection and carry this Mac's address; anything else means something is off.
  if (!o || o.challenge !== toB64url(conn.bind) || o.user?.id !== toB64url(concat(pair.hostId, pair.sigKey))) {
    throw new PerchError('wrong-mac');
  }
  let error = null;
  for (;;) {
    try {
      const cred = await conn.guard(ui.askCreate({ name: hi.name, error, run: () => createPasskey(o) }));
      conn.send({ t: 'pair-cred', response: cred.json, label: ctx.label });
      return;
    } catch (e) {
      if (e instanceof PerchError) throw e;
      const kind = webauthnErrorKind(e);
      if (kind === 'exists') throw new PerchError('denied', { reason: 'exists', final: true });
      if (kind === 'wrong-site') throw new PerchError('denied', { reason: 'origin', final: true });
      error = kind === 'cancelled'
        ? 'The passkey wasn\'t made: the request was closed before it finished. Tap the button to try again.'
        : `The passkey couldn't be made (${e.name || 'error'}). Tap the button to try again.`;
    }
  }
}

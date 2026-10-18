# Perch protocol

This is the contract between the three parts of Perch:

- **the website** (`site/`, served from `https://just-rice.github.io/perch/`): the viewer;
- **the Mac app** (`host/app/`, Swift): screen and sound capture, video encoding, input, menu bar, login item;
- **the Mac host** (`host/node/`, Node.js, a child process of the app): rendezvous, WebRTC, sign-in, Setup page.

Protocol version: **1** (`PROTO` in `site/js/shared/proto.js`). Shared code for both website and host lives in
`site/js/shared/` and must stay plain ES modules that run in browsers and in Node 22+.

## Identities and secrets (per Mac)

| Name | Size | Where it lives | Purpose |
|---|---|---|---|
| `hostId` | 16 random bytes | `config.json` | Which Mac. Hashed into the rendezvous topic. |
| `sigKey` | 32 random bytes | secrets | Seals rendezvous messages for passkey sign-ins and pairing. |
| `macName` | e.g. `amber-otter-4821` | `config.json` | Human name; the username for backup sign-in. |
| TOTP secret | 20 random bytes | secrets | Authenticator app codes (RFC 6238, SHA-1, 6 digits, 30 s). |
| OPAQUE server setup | library string | secrets | Backup sign-in server key. |
| OPAQUE registration record | library string | `config.json` | Backup password verifier (not the password). |
| Devices | per passkey | `config.json` | credential id, COSE public key, counter, transports, label, dates. |

`config.json` lives in `$PERCH_HOME` (default `~/Library/Application Support/Perch/`, mode 0600). Secrets live in the
login Keychain (generic password, service `io.github.just-rice.perch`, account `secrets`, a JSON object
`{sigKey, totpSecret, opaqueServerSetup}` with byte values in base64url) — or in `$PERCH_HOME/secrets.json` when
`PERCH_SECRETS=file` (tests).

Each Mac also has a fixed DTLS certificate (`secrets.dtls`, made once, replaced only by Start over); every WebRTC
connection uses it. Its **pin** is the first 16 bytes of its SHA-256 fingerprint.

Every passkey made for a Mac has **user handle = `hostId ‖ sigKey ‖ pin`** (64 bytes, WebAuthn's maximum; passkeys
made by Perch 0.1 have the 48-byte `hostId ‖ sigKey`, which is still accepted). A synced passkey therefore carries
everything a new device needs to find its Mac, and to recognise it: the viewer ignores any offer whose certificate
doesn't match the pin, so someone else holding `sigKey` (an old pairing link, a removed device) can't pose as the Mac.

## Rendezvous

Viewer and Mac meet through every broker in `BROKERS` (public MQTT 3.1.1 over secure WebSocket, QoS 0) at once.

Topics (`site/js/shared/rendezvous.js`):

- host topic `perch/v1/h/<b64url(SHA-256("perch topic v1" ‖ hostId))[0..22]>` — passkey sign-ins and pairing;
- name topic `perch/v1/n/<b64url(SHA-256("perch name v1" ‖ utf8(normalized macName)))[0..22]>` — backup sign-in,
  subscribed only while backup sign-in is on;
- reply topic `<topic>/<sid>` — the viewer subscribes to it before saying hello; the Mac answers there.

Envelope: every MQTT payload is `{"v":1,"i":<b64url 12-byte IV>,"c":<b64url AES-GCM ciphertext>}` where the AAD is the
UTF-8 topic and the plaintext is a JSON message with `ts` (sender's clock, ms). Receivers drop envelopes over 64 KB,
with `|now − ts| > 5 min`, that fail to decrypt, or whose IV was already seen. Keys: host topic and its reply topics
use `HKDF(sigKey, salt "perch env v1", info "host")`; name topic and its reply topics use
`HKDF(utf8(normalized macName), "perch env v1", "name")`. (The name key only hides traffic from casual observers;
security never depends on it — see Binding.)

Messages (all carry `sid`, a random 16-byte base64url session id chosen by the viewer):

1. viewer → topic: `{t:"hello", sid, pv, route, label, pairId?}` — `pv` = viewer's `PROTO`; `route` is
   `"passkey"`, `"backup"` or `"pair"`; `label` is a short device description such as `"Safari on iPhone"`.
2. Mac → reply topic: `{t:"offer", sid, pv, minPv, hv, sdp, iceServers?}` — `hv` is the app version; `sdp` the
   complete offer (ICE gathering finished, no trickle); `iceServers` the owner's relay logins, if a relay is set up
   (see Relay). Or `{t:"refuse", sid, reason, retryAfter?, pv, minPv, hv}` where reason is
   `version | busy | paused | locked-out | backup-off | not-set-up | rate`.
3. viewer → topic: `{t:"answer", sid, sdp}` — the complete answer (ICE gathering finished or 3 s passed).

The viewer refuses a Mac whose `pv < MIN_PEER_PROTO` ("Update Perch on your Mac"); the Mac refuses a viewer whose
`pv < minPv` ("version"), and the page then tells the user to reload. The Mac rate-limits hellos (20 a minute) and
keeps at most 3 unauthenticated sessions, each per topic (see Limits); each must answer within 15 s and finish
signing in within `AUTH_TIMEOUT_MS` (2 minutes).

Brokers that want a (public) login carry it in their URL (`wss://public:public@public.cloud.shiftr.io/`); the login
goes in MQTT's CONNECT and the WebSocket uses the plain URL. That broker listens on port 443, so viewers on networks
that only allow ordinary web traffic can still reach the Mac.

## Relay

Optional, per Mac: the owner's own Cloudflare TURN key (Turn Token ID and API token), saved in Setup and kept with the
secrets. For each hello the Mac obtains short-lived (24 h) TURN logins from
`POST https://rtc.live.cloudflare.com/v1/turn/keys/<id>/credentials/generate-ice-servers` (cached until 12 h remain)
and puts the TURN entries in the offer's `iceServers`. Both sides pass relay settings through
`site/js/shared/relay.js` `cleanIceServers` (stun/turn/turns URLs only, no port 53, TURN entries need a login). The
viewer adds them to its own STUN servers, so on a network that blocks direct connections its browser reaches the Mac
through `turns:turn.cloudflare.com:443`. The Mac itself does not use the relay. If Cloudflare can't be reached the
offer simply has no relay. The logins travel inside the sealed envelope; anyone able to open it (a holder of the
rendezvous key, or of the Mac's name on the backup route) could use them until they expire, which would only cost the
owner relay traffic.

## WebRTC

The Mac is the offerer. Its offer has:

- a video transceiver, `sendonly`, **H.264 only**: `profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1`,
  RTCP feedback `nack`, `nack pli`, `goog-remb`;
- an audio transceiver, `sendonly`, Opus 48 kHz stereo (`minptime=10;useinbandfec=1`);
- three data channels it creates, all JSON text: `control` (ordered, reliable), `input` (ordered, reliable: buttons,
  keys, scrolling, text) and `pointer` (unordered, `maxRetransmits: 0`: pointer moves only, so a lost or late move
  never holds up anything and is simply superseded by the next one).

ICE servers: `ICE_SERVERS` (public STUN), passed explicitly (werift otherwise falls back to Google's STUN server even
when given none). No TURN relay in version 1. No media is sent, and no input is accepted, until the session is
signed in.

Video: the Mac encodes Constrained Baseline H.264 with VideoToolbox's low-latency rate control (it meets the target
bitrate by dropping frames rather than overshooting), from video-range NV12 (`420v`). The low-latency encoder never
makes keyframes on its own, so the Mac makes one when the session starts, on every PLI from the browser and on
`{t:"keyframe"}`. ScreenCaptureKit sends nothing while the screen is still, so the Mac re-encodes the last frame about
once a second when no new one arrived. werift has no H.264 packetizer; the host has its own (RFC 6184 single NAL,
STAP-A, FU-A at 1200-byte payloads). NACK retransmission and RTCP sender reports are werift's.

Audio: ScreenCaptureKit delivers 20 ms of 48 kHz Float32 stereo per buffer; the Mac encodes each buffer as one Opus
packet with AudioToolbox (64 kbit/s) and the host sends it with RTP timestamp steps of 960.

## Binding

After the `control` channel opens, the Mac sends `hi` with a fresh 32-byte `nonce`. Both sides compute

```
bind = SHA-256("perch bind v1" ‖ nonce ‖ SHA-256(offerSdpText) ‖ SHA-256(answerSdpText))
```

over the SDP texts **exactly as each side sent or received them** (`site/js/shared/bind.js`). The SDPs carry the DTLS
certificate fingerprints WebRTC verifies in its handshake, so a party that substituted either SDP to sit in the middle
makes the two sides compute different values. Every sign-in proof is made over `bind`:

- passkey: the WebAuthn challenge **is** `bind`;
- pairing: `HMAC-SHA256(pairSecret, "perch pair v1" ‖ bind)`;
- backup: `HMAC-SHA256(opaqueSessionKey, "perch backup v1" ‖ bind)`.

werift checks that the certificate each viewer presents hashes to the fingerprint in the answer SDP
(`werift/lib/webrtc/src/transport/dtls.js`, `verifyRemoteCertificateFingerprint`; a tampered fingerprint fails the
connection). It does **not** check the DTLS handshake signatures, so it doesn't prove the viewer holds that
certificate's private key. That doesn't weaken Perch's sign-in, for three reasons. Browsers do fully verify the
certificate the Mac announces and its signature, and with a pin (see Identities) the browser only accepts the Mac's
own certificate. Every proof answers the nonce the Mac sent inside one specific DTLS session, and must come back
inside that same session; a one-tap passkey instead signs the viewer's own certificate, which the viewer only ever
uses with the pinned Mac, and its `r` works once — so a copy is useless elsewhere. And the Mac sends nothing sensitive
before sign-in. Someone who completes a DTLS handshake with the Mac by replaying a viewer's public certificate gets a
session of their own, and the real viewer will never sign that session's nonce. SECURITY.md records this as a known
limitation.

## Control channel: signing in

Mac → viewer first: `{t:"hi", pv, hv, nonce, name, route}`.

**Passkey** (`route:"passkey"`):

1. viewer: `navigator.credentials.get({publicKey: {challenge: bind, rpId, allowCredentials: [known credential] or [],
   userVerification: "required"}})` → `{t:"assert", response}` (`response` = `PublicKeyCredential.toJSON()` shape:
   `{id, rawId, type, response: {clientDataJSON, authenticatorData, signature, userHandle}, clientExtensionResults}`).
2. Mac verifies: the credential is one of its devices; `id` = `rawId`; signature; `type` `webauthn.get`; challenge =
   `bind`; origin is `APP_ORIGIN` (or the test origin); `crossOrigin` false/absent and no `topOrigin`; rpIdHash =
   SHA-256(`RP_ID`); user present and **user verified**; counter not going backwards (0/0 allowed for synced
   passkeys; the new counter is saved after every sign-in); user handle, if sent, = `hostId ‖ sigKey`. The
   `crossOrigin`/`topOrigin` check is Perch's own: `@simplewebauthn/server` only checks it for sign-in, never for
   registration, and Perch applies it to both.
3. Mac → `{t:"totp"}`; viewer → `{t:"code", code:"123456"}`; Mac → `{t:"ready", ...}` or
   `{t:"denied", reason, retryAfter?, final}`.

**Backup** (`route:"backup"`, OPAQUE, `@serenity-kit/opaque`, userIdentifier = normalized macName):

1. viewer: `client.startLogin({password})` → `{t:"opaque1", req}`; the Mac counts this as an attempt.
2. Mac: `server.startLogin(...)` → `{t:"opaque2", res}`.
3. viewer: `client.finishLogin(...)`; if it returns nothing the password was wrong: `{t:"opaque-fail"}` and stop.
   Otherwise `{t:"opaque3", fin, proof}` with `proof` = backup HMAC above.
4. Mac: `server.finishLogin(...)`, checks `proof`, then `{t:"totp"}` → `{t:"code"}` → `ready` / `denied`.

**Pairing** (`route:"pair"`, from a pairing link):

1. viewer → `{t:"pair1", pairId, proof}` (pairing HMAC above).
2. Mac checks the link is unexpired and unused → `{t:"pair-options", options}` where `options` is
   `PublicKeyCredentialCreationOptionsJSON`: challenge = `bind`, `rp {id: RP_ID, name: "Perch"}`,
   `user {id: hostId‖sigKey, name: "Perch · <macName>", displayName: "Perch on <macName>"}`, ES256/EdDSA/RS256,
   `residentKey: "required"`, `userVerification: "required"`, `attestation: "none"`, `excludeCredentials` = devices.
3. viewer: `navigator.credentials.create()` (after a tap, so Safari allows it) → `{t:"pair-cred", response, label}`.
4. Mac verifies the registration over `bind`, then `{t:"totp"}` → `{t:"code"}`; on success it saves the device and
   sends `{t:"paired", name, credentialId}` followed by `ready`. A pairing link works once; three bad proofs burn it.

**One-tap sign-in** (`caps: ["quick"]` in the offer; `site/js/shared/bind.js`). When a browser doesn't know which Mac
a passkey is for, asking for it twice (once to read the user handle, once to sign the nonce) is avoided: the browser
makes its WebRTC certificate first and the passkey signs `SHA-256("perch quick v1" ‖ r ‖ ts ‖ fingerprint)` with a fresh
16-byte `r`, the time `ts` (ms) and the browser's own certificate fingerprint. The user handle names the Mac and its
pin; the browser connects with that certificate, refuses offers that don't match the pin, and on `hi` sends
`{t:"assert", response, quick: {r, ts}}`. The Mac requires that the answer SDP announces exactly one sha-256
fingerprint, recomputes the challenge with it, and accepts each `r` once and `ts` within 3 minutes. Then the code, as
usual.

**Limits.** Five wrong 6-digit codes on a route lock that route for 1 minute, doubling per further failure up to 1
hour; a success resets it. A failed passkey step never counts (a signature can't be guessed, and counting it would
let anyone with `sigKey` lock the owner out); backup sign-in counts each password attempt. Passkey, pairing and backup
have separate counters, so a stranger guessing at the backup route or someone with a pairing link can't lock the
owner's passkeys. Hellos are limited per topic (host topic: passkey and pairing; name topic: backup), 20 a minute and
3 sessions signing in at once each, and a session whose viewer hasn't answered the offer within 15 s is dropped. TOTP codes are accepted for the previous, current and
next 30-second step, and each step only once.

`ready`: `{t:"ready", name, hv, display: {id, width, height}, displays: [{id, name, width, height, main}],
quality, audio, input, locked}` — `input` false means Accessibility permission is missing (view only).

## Control channel: during a session

viewer → Mac: `{t:"quality", preset}` (`smooth | balanced | sharp`), `{t:"display", id}`, `{t:"keyframe"}`,
`{t:"ping", n, ts}`, `{t:"bye"}`.

Mac → viewer: `{t:"pong", n, ts}`, `{t:"status", locked, link: "good"|"slow", kbps, fps, width, height, input}`,
`{t:"error", code, message}` (codes: `no-screen-permission`, `capture-failed`), `{t:"bye", reason}`
(`signed-in-elsewhere | paused | quit | idle | removed | disconnected`).

Only one viewer is signed in at a time: a newly signed-in viewer takes over and the old one gets
`bye signed-in-elsewhere`. A session with no input for `idleMinutes` (default 60) ends with `bye idle`.

## Input and pointer channels

viewer → Mac, JSON, coordinates normalized to the shown display (`0..1`, origin top-left). `m` goes on the `pointer`
channel; everything else on `input`. Buttons and scrolls carry their own coordinates, so they never depend on a move
having arrived:

| Message | Meaning |
|---|---|
| `{t:"m", x, y}` | pointer moved |
| `{t:"b", b, d, x, y, n}` | button `b` (0 left, 1 middle, 2 right) down (`d:true`) or up, `n` = click count |
| `{t:"w", dx, dy, x, y}` | scroll, DOM `WheelEvent` deltas in CSS pixels (positive `dy` = page moves up) |
| `{t:"k", c, k, d, m}` | key: DOM `code` (`"KeyA"`), DOM `key`, down/up, modifiers bitmask (1 shift, 2 ctrl, 4 alt, 8 meta) |
| `{t:"txt", s}` | typed text (phone keyboards, emoji, IME), at most 256 characters |
| `{t:"rel"}` | release every held key and button (viewer lost focus) |

The Mac maps `code` to macOS virtual key codes (US layout positions) and posts events with Quartz Event Services.

## App ⇄ host process (IPC)

The Swift app starts the Node host as a child process and talks to it over the child's stdin (app → host) and
stdout (host → app). stderr is the host's log. Every frame is `[u32 big-endian length of the rest][u8 type][payload]`.

| Type | Direction | Payload |
|---|---|---|
| `0x01` HELLO | app → host | JSON `{app, version, ipc: 1, macos, synthetic, permissions: {screen, accessibility}, displays, loginItem}` |
| `0x02` VIDEO | app → host | `u8 flags` (bit 0 keyframe) · `u64 BE pts µs` · H.264 Annex-B access unit (SPS/PPS before every keyframe) |
| `0x03` AUDIO | app → host | `u64 BE pts µs` · one Opus packet (20 ms, 48 kHz stereo) |
| `0x04` EVENT | app → host | JSON event (below) |
| `0x10` COMMAND | host → app | JSON command (below) |
| `0x11` INPUT | host → app | JSON input message from the table above, already validated |

Events (`e`): `permissions {screen, accessibility}`, `displays {displays}`, `capture-started {display, width, height, fps}`,
`capture-stopped {reason}`, `capture-error {code, message}`, `lock {locked}`, `login-item {on, status, error?}`,
`menu {action}` (`pause | resume | disconnect | backup-on | backup-off | keep-awake-on | keep-awake-off |
login-item-on | login-item-off | check-updates | update | quit`), `input-echo {ev}` (only with `--echo-input`),
`log {level, message}`.

Commands (`c`): `capture {on, display?, maxEdge, fps, kbps, audio}`, `keyframe {}`, `bitrate {kbps}`,
`session {active, viewer?, route?}` (menu light, notification, keeps the display awake while active),
`status {state, text, macName, setupUrl, settings, update?}` (menu bar contents), `notify {title, body}`,
`permissions {}` (asks for a `permissions` event), `request-permission {which}` (`screen | accessibility`),
`open-url {url}`, `login-item {on}`, `keep-awake {on}`, `uninstall {}`, `quit {}`.

`state` is one of `starting | ready | needs-setup | offline | paused | connected | error`.

## Setup page (local only)

The host serves Setup on `http://127.0.0.1:<random port>/` and only answers requests that carry its random key
(`?k=` on the first load, then the `X-Perch-Key` header), whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`,
and — for POSTs — whose `Origin` matches. The app's "Open Setup…" menu item opens that URL. The API is under `/api/`;
see `host/node/src/setup-server.mjs`.

Pairing links look like `https://just-rice.github.io/perch/connect.html#pair=<b64url(hostId ‖ sigKey ‖ pairId ‖ pairSecret ‖ pin)>`
(the pin is missing from links made by Perch 0.1) and expire after 10 minutes.

## Test mode

With `PERCH_TEST=1` the host also honours `PERCH_HOME`, `PERCH_SECRETS=file`, `PERCH_BROKERS` (comma list),
`PERCH_TEST_ORIGIN` (an extra accepted origin such as `http://localhost:8765`), `PERCH_RP_ID`, `PERCH_SITE` (base for
pairing links), `PERCH_SETUP_PORT`, `PERCH_SETUP_KEY` and `PERCH_ICE` (`none` = host candidates only), and exposes
`GET /api/test/state` and `GET /api/test/input-echo`. The website accepts `?brokers=` and `?test=1` only when served
from `localhost` or `127.0.0.1`. The app accepts `--synthetic` (moving test pattern and a test tone instead of the
real screen and sound), `--echo-input` (report input instead of performing it), `--no-ui` (no menu bar item),
`--node <path>` and `--host <path>` (development).

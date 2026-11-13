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
| `macName` | e.g. `amber-otter-4821` | `config.json` | Human name; the username for backup sign-in. Made up by Perch (`MAC_NAME_RE`), or chosen by the owner in Setup (`CUSTOM_MAC_NAME_RE`: 4–40 letters, digits and single hyphens; not recommended). |
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

Logins come from the owner's own Cloudflare TURN key when one is set in Setup, and otherwise from Perch's shared relay
service (below) when `RELAY_SERVICE_URL` in `shared/proto.js` is set and the `sharedRelay` setting is on (the default).
Logins are handed out while at least half their life remains, and refreshed in the background after a quarter.

With the owner's own key (Turn Token ID and API token, kept with the secrets), the Mac obtains short-lived (24 h) TURN
logins from
`POST https://rtc.live.cloudflare.com/v1/turn/keys/<id>/credentials/generate-ice-servers` (cached until 12 h remain)
and puts the TURN entries in the offer's `iceServers`. Both sides pass relay settings through
`site/js/shared/relay.js` `cleanIceServers` (stun/turn/turns URLs only, no port 53, TURN entries need a login). The
viewer adds them to its own STUN servers, so on a network that blocks direct connections its browser reaches the Mac
through `turns:turn.cloudflare.com:443`. The Mac itself does not use the relay. If Cloudflare can't be reached the
offer simply has no relay. The logins travel inside the sealed envelope; anyone able to open it (a holder of the
rendezvous key, or of the Mac's name on the backup route) could use them until they expire, which would only cost the
owner relay traffic.

### Relay service

`relay-service/` is a Cloudflare Worker run by whoever publishes Perch; it hands relay logins to Perch Macs within
limits, from one TURN key on its own Cloudflare account. `relay-service/src/request.js` is the request format:
`POST <service>/v1/ice {v: 1, mac, ts, sig, owner?}`, where `mac` is the Mac's relay key (Ed25519 public key, made once
and kept with the secrets), `sig` its signature over `perch relay v1|<mac>|<ts>|<owner>`, and `owner`, on the service
owner's own Macs only, HMAC-SHA256 of `perch relay owner v1|<mac>` under the owner key (typed into Setup; never sent).
Answers: `{ok: true, iceServers, ttl, usage}` or `{ok: false, reason, message, usage?}` with `reason` one of
`mac | others | total | unknown | busy | bad | turn`. `usage` is `{macBytes, macLimitBytes, windowDays}`, plus the
totals for the owner's Macs.

Each login is tagged in Cloudflare with `customIdentifier = "m-" + base64url(SHA-256(mac))[0..22]`. Every five minutes
the service reads Cloudflare's TURN analytics (`egressBytes`, which is what Cloudflare bills) for yesterday and today,
keeps per-day numbers, and revokes live logins that a limit no longer allows. The limits are counted over the last 31
days, so no billing month can pass them whatever day it starts on: 20 GB per Mac that isn't the owner's, 900 GB for all
of those together, and 990 GB for everything on the account (never configurable above 990). New logins last 3 hours
for other people's Macs, 24 for the owner's, and 1 hour for everyone within 40 GB of the total. While the numbers
can't be read for 30 minutes, other people's Macs get no new logins. `GET /v1/status` with `Authorization: Bearer
<owner key>` shows everything.

## Worker relay

Optional, per Mac, and needing no payment details: the owner's own Cloudflare Worker (`relay/`, deployed with
`wrangler deploy`; Durable Objects on the Workers free plan). When WebRTC can't get through, the two ends talk over
WebSockets to it instead, and it passes bytes between them. Shared code: `site/js/shared/wsrelay.js`; Mac side
`host/node/src/wsrelay.mjs`; viewer side `site/js/ui/connection.js` and `site/js/ui/relaymedia.js`.

**Setting it up.** Setup saves the Worker's address (`https://<name>.workers.dev` only: the website's CSP allows
`wss://*.workers.dev` and nothing else). The Mac reads `GET /v1/info` (`{perch: "relay", v: 1, claimed}`); if the
relay is unclaimed it claims it with `POST /v1/claim {secret}` (32 random bytes, hex), and the first claim wins (or
the Worker's `RELAY_SECRET`, if its owner set one). It then proves it holds the secret with
`GET /v1/check?auth=HMAC-SHA256(secret, "perch relay check v1")` and keeps `{url, secret}` with the secrets.

**Offer and answer.** With a relay set up, every offer also carries `ws`, the relay offer text:
`{"v":1, sid, url, room, eph, cert?, sig?}` — `room` 16 random bytes (base64url), `eph` the Mac's fresh ECDH P-256 key
(65-byte uncompressed point), `cert` the Mac's DTLS certificate (DER) and `sig` its ECDSA P-256 signature (IEEE P1363)
over `SHA-256("perch ws offer v1" ‖ sid ‖ "\n" ‖ url ‖ "\n" ‖ room ‖ eph)`. A viewer with the Mac's pin requires
`cert` and `sig`, the first 16 bytes of `SHA-256(cert)` = pin, and a valid signature; without a pin (backup sign-in)
the binding protects it, as below. A viewer that uses the relay answers `{t:"answer", sid, ws}` instead of `sdp`, with
`ws` = `{"v":1, sid, eph}` (its own fresh key).

The viewer uses the relay when the Mac offers one and its browser has WebCodecs `VideoDecoder`, and either its answer
has no `srflx` or `relay` candidate although STUN servers were asked (UDP is blocked: WebRTC can't work), or a WebRTC
attempt failed before `hi` (it then connects again, over the relay). On the relay the viewer leaves out the `quick`
and `mic` caps: one-tap sign-in is tied to a WebRTC certificate, and there is no microphone line.

**Keys.** `shared = ECDH(eph_mac, eph_viewer)`; `salt = SHA-256("perch ws salt v1" ‖ SHA-256(offerText) ‖
SHA-256(answerText))`; two AES-256-GCM keys `HKDF-SHA256(shared, salt, "perch ws mac to viewer v1" | "perch ws viewer
to mac v1")`. **Binding**: `offerSdp` and `answerSdp` in the binding (see Binding) are the relay offer and answer texts,
exactly as sent and received, so a party that swapped either key makes every sign-in proof fail.

**Rooms.** The Mac opens `wss://…/v1/room/<room>?role=mac&auth=HMAC-SHA256(secret, "perch relay room v1" ‖ room)`
once the answer arrives; the viewer opens `…?role=viewer` once it has sent it. A room holds one of each; each gets the
text `peer` when the other is there (within 30 s, or both are closed), and only then are the channels open. Binary
messages go across unchanged; `ping` is answered `pong`; either side leaving closes the other.

**Messages.** Every binary message is `[u64 BE counter][AES-GCM(key, iv = 0⁴ ‖ counter, aad "perch ws v1",
u8 flags ‖ u8 type ‖ payload)]`. Counters start at 0 in each direction and must go up by exactly one (anything else
ends the connection). Payloads over 256 KB are split; flag bit 0 means more pieces follow. Types: `1` control, `2`
input, `3` pointer (UTF-8 JSON, exactly as on the WebRTC data channels of those names); `16` video: `u8 flags` (bit 0
keyframe) · `u64 BE pts µs` · the H.264 Annex-B access unit; `17` audio: `u8 count` · count × (`u64 BE pts µs` ·
`u16 BE length` · one Opus packet), up to three packets per message.

**Rendezvous through the relay.** The relay is also a broker: `wss://…/v1/mqtt` speaks the MQTT subset Perch's
client uses (CONNECT, QoS 0 PUBLISH and SUBSCRIBE, UNSUBSCRIBE, PINGREQ, DISCONNECT), for exact topics under
`perch/v1/` only (no wildcards; at most 8 per connection; a publish is at most 70 KB and limited to a burst of 60 and
2 a second per connection). Everything published there is the same sealed envelope as on the public brokers. The Mac
adds it to its brokers while a relay is set up, and names the relay to signed-in viewers in `ready` (`relay`, its
https address), which remember it with the Mac (`perch.macs.v1`, `relay`) and add its broker the next time.

**The website from the relay.** The relay Worker also serves `site/` (Workers static assets) from its own address. A
page whose origin is a `workers.dev` relay (`GET /v1/info` answers `{perch: "relay"}`) puts that relay's broker first,
so it can find the Mac even on a first visit where only `*.workers.dev` gets through. Passkeys belong to that address,
so it is one of the Mac's sites (Setup, "Sites that can sign in"), and devices pair there once.

**Media.** There are no receiver reports: the Mac drops video frames while more than about half a second of the
target bitrate is waiting in its WebSocket (asking for a keyframe, since what follows can't be decoded), and feeds the
share of dropped frames to the same bitrate controller as WebRTC's loss. The viewer decodes with WebCodecs
(`VideoDecoder`, codec from the SPS; `AudioDecoder` for Opus when the browser has it) onto a canvas and an
AudioContext, and hands the viewer an ordinary MediaStream from `canvas.captureStream()` and a
`MediaStreamAudioDestinationNode`. A viewer that falls behind skips to the next keyframe (`{t:"keyframe"}`).

## WebRTC

The Mac is the offerer. Its offer has:

- a video transceiver, `sendonly`, **H.264 only**: `profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1`,
  RTCP feedback `nack`, `nack pli`, `goog-remb`;
- an audio transceiver, `sendrecv`, Opus 48 kHz stereo (`minptime=10;useinbandfec=1`): the Mac's sound out, and
  the viewer's microphone back when they turn it on (see `mic` below);
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

Picture size and bitrate (`host/node/src/media.mjs`). The bitrate target follows the browser's receiver reports
(loss) and its bandwidth estimate (REMB); a low estimate is ignored while little is being sent (a still screen),
because the estimate can't exceed about 1.5 times what the browser receives. The picture's longest edge is the
smallest of: the preset's `maxEdge`, the viewer's screen (`view`), and what the link carries at full frame rate
(`EDGE_LADDER` / `EDGE_NEEDS_KBPS`: step down after two low readings, up one step after five good ones). A size
change on the same display resizes the running stream and swaps the encoder (no restart); `capture` commands carry
the current bitrate target. After the last new picture the Mac repeats it several times a second for 1.5 s so the
encoder can sharpen it, and a picture dropped by rate control is tried again within 40 ms.

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

**Guest link** (`route:"guest"`). The owner can make a link that lets someone watch, never control:
`connect.html#guest=<b64url(guestId ‖ guestSecret ‖ pin)>`, valid for a chosen time (1 minute to 24 hours), one at a
time. It has a meeting point of its own, `perch/v1/g/<hash(guestId)>` sealed with `HKDF(guestSecret, …, "guest")`, so
it reveals nothing about the Mac's usual address or key. After `hi` the guest sends
`{t:"guest1", proof: HMAC-SHA256(guestSecret, "perch guest v1" ‖ bind)}` and gets `ready` with `guest: true,
input: false` (no passkey, no code: the link is the pass). Up to 3 guests at once receive the same picture and sound
as the owner's viewer (or the main display when the owner isn't connected); their input and every control message
except `ping` and `keyframe` are ignored. Stopping the link or its running out ends them with `bye removed`.

**Sites.** A Mac accepts passkey sign-ins and pairings only from its list of sites: `https://just-rice.github.io`
always, plus any the owner added in Setup (`config.sites`: `{origin, url}`, https and a domain name only). A passkey
belongs to one site's domain (its RP ID, the origin's hostname), so each device is paired once per site: `pair1`
carries the viewer's `origin`, the Mac answers with creation options for that site's RP ID (or `denied origin`), and
every registration and assertion is verified against the origin in its signed client data and that site's RP ID.
Devices remember their RP ID; removing a site removes the devices paired there. Pairing links are made for a chosen
site (`pairStart(site)`). The backup route has no origin check (the Mac can't see where a password was typed).

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

viewer → Mac: `{t:"quality", preset}` (`smooth | balanced | sharp | fast`; `fast` is 60 frames a second, offered by
Macs with `fps60` in the offer's `caps`), `{t:"display", id}`, `{t:"keyframe"}`, `{t:"view", edge}` (the longest edge
of the picture on the viewer's screen in device pixels, for Macs with `view` in `caps`: the Mac never sends a bigger
picture than that), `{t:"ping", n, ts}`, `{t:"bye"}`.

For Macs with `window` in `caps` (never for guests): `{t:"windows"}` asks which windows are on screen (answered with
`{t:"windows", list: [{id, app, title, width, height}]}`, front to back, sizes in points);
`{t:"window", id}` shows only that window, `id: null` the whole display again; `{t:"fit", w, h}` reshapes the window
being shown to the shape `w:h` (the viewer's own screen), as large as the Mac's display allows, answered with
`{t:"fit", ok}`. "Shows only that window" means the picture is the part of the display the window covers, and it
follows the window as it moves or changes size; whatever is in front of it there is in the picture too, so what the
viewer sees is always what their clicks reach. Pointer positions stay 0..1 across the picture. The window is brought
to the front when chosen. When it closes, is minimised or leaves the desktop, the Mac goes back to the whole display
(`status.window` becomes `null`). Choosing another display forgets the window.

For Macs with `clipboard` in `caps` (never for guests): `{t:"clip-set", text, paste?}` puts the text (at most 30,000
UTF-16 units) on the Mac's clipboard and, with `paste: true`, presses ⌘V there; answered `{t:"clip-set", ok}`.
`{t:"clip-get"}` asks for the Mac's clipboard text (cut to 30,000 units); answered `{t:"clip", ok, text}`.

With `clipimg` in `caps` as well, pictures go both ways, at most 20 MB. A picture travels as base64 in pieces of at most
49,152 characters, `{t:"clip-part", id, i, n, data}` for `i` = 0…n−1 in order, followed by the message that names it:
`{t:"clip-set", text?, img: {id, mime}, paste?}` from the viewer (text is optional when there is a picture), or
`{t:"clip", ok, text, img: {id, mime: "image/png"}}` from the Mac (`clip-get` with `images: true`). Pieces have their own
rate allowance. `{t:"clip-sync", on}` asks the Mac to send whatever is copied there from now on, unasked, as
`{t:"clip", ..., auto: true}` (with the picture, if any). The viewer uses these for ⌘V (Ctrl+V with the keys swapped):
it holds the key back, takes the browser's paste event, sends this device's clipboard with `paste: false`, and presses ⌘V
once the Mac answers `ok`.

For Macs with `textfocus` in `caps`: after a left click the Mac sends `{t:"textfocus", editable, secure}` (whether its
focused element now takes typing, and whether it is a password box), so a phone can bring up its keyboard by itself.

For Macs with `mic` in `caps` (never for guests): the sound line of the offer is `sendrecv`, and a viewer that
answers `sendrecv` may send its microphone back on it as Opus. `{t:"mic", on}` says the viewer has turned it on or
off; only while it is on does the Mac pass the packets to the app, which plays them on the sound output chosen in
Setup (`settings.micOutput`, a device UID, or `""` for the Mac's current output). `{t:"mic", on: false, error?}`
from the Mac means it could not play it (the output is gone) and the viewer should stop sending. What Perch plays is
left out of the sound it sends, so the viewer doesn't hear themselves.

Mac → viewer: `{t:"pong", n, ts}`, `{t:"status", locked, link: "good"|"slow", kbps, fps, width, height, input, window}`
(`window`: the id of the one window being shown, or `null`; plus `displays` and `display` when the Mac's displays
change),
`{t:"error", code, message}` (codes: `no-screen-permission`, `capture-failed`), `{t:"bye", reason}`
(`signed-in-elsewhere | paused | quit | idle | removed | disconnected`).

Only one viewer is signed in at a time: a newly signed-in viewer takes over and the old one gets
`bye signed-in-elsewhere`. A session with no input for `idleMinutes` (default 60; 0 = never) ends with `bye idle`.

## Input and pointer channels

viewer → Mac, JSON, coordinates normalized to the shown display (`0..1`, origin top-left). `m` goes on the `pointer`
channel; everything else on `input`. Buttons and scrolls carry their own coordinates, so they never depend on a move
having arrived:

| Message | Meaning |
|---|---|
| `{t:"m", x, y, dx?, dy?}` | pointer moved; with the viewer's mouse captured (pointer lock), `dx`/`dy` say how far it moved in fractions of the picture (−1..1), passed on as the event's movement even where the position is pinned at the screen's edge. Every move carries its movement in the Quartz event (`mouseEventDeltaX/Y`), which games and 3D apps read |
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
| `0x12` MIC | host → app | `u16 BE sequence number` · one Opus packet of the viewer's microphone |

Events (`e`): `clipboard-changed {}` (while a viewer is connected, something other than Perch changed the clipboard), `text-focus {editable, secure}` (a moment after each left click: whether the focused element now takes
typing, from Accessibility; test runs pretend the top half of the screen is a text box), `permissions {screen, accessibility}`, `displays {displays}`, `capture-started {display, width, height, fps, window?}`,
`audio-outputs {list: [{uid, name, main}]}` (after HELLO and whenever the Mac's sound outputs change),
`mic {on, ok, error?}`, `mic-level {packets, frames, late, rms}` (test runs only, which decode but never play),
`windows {list}`, `window-gone {window}` (the window being shown left the screen; the app is already showing the
whole display), `window-fit {window, ok, error?}`,
`capture-stopped {reason}`, `capture-error {code, message}`, `lock {locked}`, `login-item {on, status, error?}`,
`menu {action}` (`pause | resume | disconnect | backup-on | backup-off | keep-awake-on | keep-awake-off |
login-item-on | login-item-off | check-updates | update | quit`), `input-echo {ev}` (only with `--echo-input`),
`log {level, message}`.

Commands (`c`): `capture {on, display?, maxEdge, fps, kbps, audio, window?}` (`window`: show only the part of the
display that window covers, following it), `windows {}` (asks for a `windows` event), `window-fit {window, w, h}`
(reshape it to `w:h` through Accessibility; never done in test runs), `clipboard-get {images?, auto?}` (answered with a `clipboard {ok, text, image?, mime?, auto?}` event; `image` is base64 PNG), `clipboard-set {text?, image?, paste?}` (answered with
`clipboard-set {ok}`; test runs use a pretend clipboard), `mic {on, device?}` (start or stop playing
MIC frames; only during a session), `keyframe {}`, `bitrate {kbps}`,
`session {active, viewer?, route?, curtain?}` (menu light, notification, keeps the display awake while active;
`curtain: true` blacks out the Mac's own displays with windows left out of the capture, lifted by three Esc presses
at the Mac), `lock {}` (lock the screen; sent when a session ends and the owner chose "lock when a session ends"),
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

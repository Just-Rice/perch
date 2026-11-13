# Security

Perch gives full control of a Mac to whoever signs in, so its security matters more than most projects'. This page
says how it protects you, what it can't protect against, and how to report a problem.

## Reporting a problem

Please report security problems **privately**: on GitHub open the repository's **Security** tab and choose
**Report a vulnerability**. Don't open a public issue for them. You'll get a reply as soon as possible; Perch is a
volunteer project, so please allow a few days.

## How Perch protects a Mac

- **The Mac is the lock.** The website is only a keypad: every check happens in the Perch app on the Mac. Nothing is
  shown, and no click or key is accepted, until a viewer has passed both steps.
- **Two steps every time.** A passkey (Face ID, Touch ID, a phone, or a security key) and a 6-digit code from an
  authenticator app. Passkeys only work on `https://just-rice.github.io`, so a look-alike site can't use them.
- **Sign-ins are tied to one connection.** The passkey signs a value built from a fresh random number the Mac sent and
  from both ends' connection descriptions (SDPs), which carry the certificates the encrypted connection uses. If
  anything in between swapped those to listen in, the value wouldn't match and the sign-in fails
  ([PROTOCOL.md, Binding](docs/PROTOCOL.md#binding)).
- **Pairing needs someone at the Mac.** A new device needs a one-time link shown in Setup on the Mac (valid 10 minutes,
  single use), plus the 6-digit code.
- **Guessing is slow.** Five wrong codes lock that way of signing in for a minute, doubling up to an hour, and codes
  work once. Passkey, pairing and backup sign-in are locked separately, so nobody can lock you out of your passkeys by
  guessing elsewhere.
- **No servers of ours, and nothing readable on anyone else's.** The free public message services that help the two
  ends find each other only carry encrypted notes. The screen, sound and input go directly between the Mac and the
  browser over WebRTC's encryption (DTLS-SRTP).
- **You can always tell.** The menu bar icon changes and a notification appears when someone connects; macOS shows its
  own screen-recording indicator. Only one viewer at a time; Setup and the menu bar can end a session at once.
- **Secrets stay on the Mac.** The authenticator secret, rendezvous key and backup sign-in key are in the login
  Keychain. Paired devices are stored as public keys only. The backup password itself is never sent or stored: an
  OPAQUE password exchange lets the browser prove it knows the password without revealing it.

## Known limitations

- **Every page on `just-rice.github.io` shares one web origin.** Browsers treat all of the projects published there
  as one site. If any of them were compromised, a malicious page could imitate Perch's sign-in. It would still need
  your passkey approval and your 6-digit code, so stay alert to unexpected prompts.
- **Recognising the Mac.** Passkeys and pairing links made by Perch 0.2 or later carry a pin of the Mac's own
  connection certificate, and the website refuses to talk to anything that can't prove it holds that certificate.
  Passkeys from Perch 0.1 have no pin: pair those devices again to get it. The backup sign-in (Mac name + password)
  has no pin either, so there the website relies on the password check (OPAQUE), which a fake Mac can't pass.
- **Guest links.** A guest link lets anyone who has it watch your screen and hear its sound until it runs out or you
  stop it. They can never control the Mac, and the link says nothing about how to reach the Mac otherwise. Treat it
  like a live window onto your screen: send it only to the person you mean, and close private things first.
- **The shared relay.** Macs without a relay key of their own may get relay logins from Perch's relay service
  (`relay-service/`), on its publisher's Cloudflare account. The relay only ever carries the encrypted connection. The
  service sees each Mac's relay key (a random public key), its internet address and how much it relays. Limits stop
  anyone from running up a bill: per Mac, for all other Macs together, and a hard ceiling of 990 GB in any 31 days.
  Anyone can make new relay keys, so the per-Mac limit alone wouldn't stop a determined abuser; the two overall
  limits do.
- **Your microphone on the Mac.** A signed-in owner (never a guest) can have their microphone played on the Mac.
  That makes sound at the Mac, on the output chosen in Setup; it gives the viewer nothing new to see or hear. The
  Mac only accepts the sound while the viewer has switched it on, and limits how much it will take.
- **Sites you add yourself.** In Setup you can let your Mac accept sign-ins from other sites, for running your own
  copy of the Perch website. Whoever controls a site on that list can see what you type there and control the Mac
  while you're signed in, so add only a site you run or fully trust. Never add a web proxy or "unblocker": it sits
  between you and the page and can read everything.
- **A lost device or pairing link.** Removing a device stops its passkey working, but it still knows how to reach
  your Mac. It can't sign in or lock you out, but it could keep trying to connect. If that ever happens, use
  **Start over** in Setup: it gives the Mac a new identity, so everything old stops working.
- **werift doesn't check DTLS handshake signatures.** The WebRTC library on the Mac checks that the browser's
  certificate matches the one announced for the session, but not the handshake signature proving the browser holds
  its private key. Perch's design doesn't rely on that check: the browser fully verifies the Mac's certificate (and its pin, from Perch 0.2), every sign-in proof
  answers a random number sent inside one specific encrypted session and must come back inside it, and the Mac sends
  nothing private before sign-in. See [PROTOCOL.md, Binding](docs/PROTOCOL.md#binding).
- **The Worker relay (optional).** On networks that block WebRTC, a relay you deploy in your own Cloudflare account
  can carry the connection over a WebSocket instead. Everything in it is end-to-end encrypted between the Mac and the
  browser (fresh ECDH keys per connection, AES-GCM, every message numbered so none can be replayed, dropped or
  reordered), the Mac signs its key with the same pinned certificate WebRTC uses, and sign-ins are bound to the
  relay's offer and answer exactly as to WebRTC's. Cloudflare and the Worker see only encrypted bytes, their sizes and
  timing, and the two ends' IP addresses. The relay only lets the Mac that claimed it open connections, so nobody else
  can use up your free allowance; a stranger who learns a connection's room can only join as the viewer, and can't
  read or forge anything. The relay is also a rendezvous broker and can serve the Perch website: like the public
  brokers it only carries sealed notes (and sees their sizes, timing and IP addresses), and anyone may use it for
  Perch's topics within its limits. A copy of the website served by your relay runs the code you deployed, so deploy
  it from the official repository. One-tap sign-in and the microphone aren't offered over the relay. See
  [PROTOCOL.md, Worker relay](docs/PROTOCOL.md#worker-relay).
- **The backup sign-in is weaker than a passkey.** A fake site or someone watching could capture the password, so it
  still needs the 6-digit code, it is off unless you set it up, and the Mac notifies you every time it is used. In an
  `about:blank` tab there's no address bar to check, so prefer the passkey there.
- **A Mac name you choose yourself.** Setup lets you pick the Mac's name instead of Perch's made-up one, and says it
  isn't recommended. A made-up name is one of about 590 million; one you choose (like `jordan-macbook`) can be guessed.
  The name is the backup sign-in's username, and its meeting point's key is made from it, so whoever guesses it can
  reach the backup sign-in and try passwords. Each try still needs the password and a 6-digit code, wrong tries lock
  the route, and the Mac notifies you. Passkey sign-ins don't use the name. With backup sign-in off, the name isn't
  listened for at all.
- **The message services see some metadata.** They see when a viewer contacts a Mac, roughly how big the encrypted
  notes are, and the IP addresses of both ends. So do the public STUN servers both ends use to discover their
  addresses.
- **Perch isn't registered with Apple.** Releases are signed with Perch's own long-lived certificate (not an Apple
  Developer ID), so macOS can't vouch for them. Install only with the official command or from the official GitHub
  releases, and check what you run.
- **Screen Recording and Accessibility are powerful permissions.** They are needed to show the screen and act for you.
  Anyone who can sign in can do anything you can do on the Mac.
- **Never pair someone else's device.** Scammers ask people to install remote-control tools. Nobody genuine will ask
  you for a Perch pairing link or code.

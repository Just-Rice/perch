> Roost is derived from Perch and shares its security model; "the Mac" below means your PC. On Windows the secrets
> live in a DPAPI-encrypted file (only your Windows account can read them) instead of the Keychain. Two Windows
> limits: without **Control admin apps**, Windows (UIPI) stops Roost's clicks and keys reaching apps that run as
> administrator, and the secure desktop (UAC prompts, the lock screen) can't be captured by any app that runs as you.

# Security

Roost gives full control of a PC to whoever signs in, so its security matters more than most projects'. This page
says how it protects you, what it can't protect against, and how to report a problem.

## Reporting a problem

Please report security problems **privately**: on GitHub open the repository's **Security** tab and choose
**Report a vulnerability**. Don't open a public issue for them. You'll get a reply as soon as possible; Roost is a
volunteer project, so please allow a few days.

## How Roost protects a PC

- **The PC is the lock.** The website is only a keypad: every check happens in the Roost app on the PC. Nothing is
  shown, and no click or key is accepted, until a viewer has passed both steps.
- **Two steps every time.** A passkey (Face ID, Touch ID, a phone, or a security key) and a 6-digit code from an
  authenticator app. Passkeys only work on `https://faarisaahmed.github.io`, so a look-alike site can't use them.
- **Sign-ins are tied to one connection.** The passkey signs a value built from a fresh random number the PC sent and
  from both ends' connection descriptions (SDPs), which carry the certificates the encrypted connection uses. If
  anything in between swapped those to listen in, the value wouldn't match and the sign-in fails
  ([PROTOCOL.md, Binding](docs/PROTOCOL.md#binding)).
- **Pairing needs someone at the PC.** A new device needs a one-time link shown in the Control Center on the PC (valid 10 minutes,
  single use), plus the 6-digit code.
- **Guessing is slow.** Five wrong codes lock that way of signing in for a minute, doubling up to an hour, and codes
  work once. Passkey, pairing and backup sign-in are locked separately, so nobody can lock you out of your passkeys by
  guessing elsewhere.
- **No servers of ours, and nothing readable on anyone else's.** The free public message services that help the two
  ends find each other only carry encrypted notes. The screen, sound and input go directly between the PC and the
  browser over WebRTC's encryption (DTLS-SRTP).
- **You can always tell.** The tray icon changes and a notification appears when someone connects. Only one viewer
  at a time; the Control Center and the tray panel can end a session at once.
- **Secrets stay on the PC.** The authenticator secret, rendezvous key and backup sign-in key are in a file encrypted
  with Windows DPAPI for your account only. Paired devices are stored as public keys only. The backup password itself is never sent or stored: an
  OPAQUE password exchange lets the browser prove it knows the password without revealing it.

## Known limitations

- **Every page on `faarisaahmed.github.io` shares one web origin.** Browsers treat all of the projects published there
  as one site. If any of them were compromised, a malicious page could imitate Roost's sign-in. It would still need
  your passkey approval and your 6-digit code, so stay alert to unexpected prompts.
- **Recognising the PC.** Passkeys and pairing links made by Roost 0.2 or later carry a pin of the PC's own
  connection certificate, and the website refuses to talk to anything that can't prove it holds that certificate.
  Passkeys from Roost 0.1 have no pin: pair those devices again to get it. The backup sign-in (PC name + password)
  has no pin either, so there the website relies on the password check (OPAQUE), which a fake PC can't pass.
- **Guest links.** A guest link lets anyone who has it watch your screen and hear its sound until it runs out or you
  stop it. They can never control the PC, and the link says nothing about how to reach the PC otherwise. Treat it
  like a live window onto your screen: send it only to the person you mean, and close private things first.
- **Your microphone on the PC.** A signed-in owner (never a guest) can have their microphone played on the PC.
  That makes sound at the PC, on the output chosen in the Control Center; it gives the viewer nothing new to see or hear. The
  PC only accepts the sound while the viewer has switched it on, and limits how much it will take.
- **Sites you add yourself.** In the Control Center you can let your PC accept sign-ins from other sites, for running your own
  copy of the Roost website. Whoever controls a site on that list can see what you type there and control the PC
  while you're signed in, so add only a site you run or fully trust. Never add a web proxy or "unblocker": it sits
  between you and the page and can read everything.
- **A lost device or pairing link.** Removing a device stops its passkey working, but it still knows how to reach
  your PC. It can't sign in or lock you out, but it could keep trying to connect. If that ever happens, use
  **Start over** in the Control Center: it gives the PC a new identity, so everything old stops working.
- **werift doesn't check DTLS handshake signatures.** The WebRTC library on the PC checks that the browser's
  certificate matches the one announced for the session, but not the handshake signature proving the browser holds
  its private key. Roost's design doesn't rely on that check: the browser fully verifies the PC's certificate (and its pin, from Roost 0.2), every sign-in proof
  answers a random number sent inside one specific encrypted session and must come back inside it, and the PC sends
  nothing private before sign-in. See [PROTOCOL.md, Binding](docs/PROTOCOL.md#binding).
- **The Worker relay (optional).** On networks that block WebRTC, a relay you deploy in your own Cloudflare account
  can carry the connection over a WebSocket instead. Everything in it is end-to-end encrypted between the PC and the
  browser (fresh ECDH keys per connection, AES-GCM, every message numbered so none can be replayed, dropped or
  reordered), the PC signs its key with the same pinned certificate WebRTC uses, and sign-ins are bound to the
  relay's offer and answer exactly as to WebRTC's. Cloudflare and the Worker see only encrypted bytes, their sizes and
  timing, and the two ends' IP addresses. The relay only lets the PC that claimed it open connections, so nobody else
  can use up your free allowance; a stranger who learns a connection's room can only join as the viewer, and can't
  read or forge anything. The relay is also a rendezvous broker and can serve the Roost website: like the public
  brokers it only carries sealed notes (and sees their sizes, timing and IP addresses), and anyone may use it for
  Roost's topics within its limits. A copy of the website served by your relay runs the code you deployed, so deploy
  it from the official repository. One-tap sign-in and the microphone aren't offered over the relay. See
  [PROTOCOL.md, Worker relay](docs/PROTOCOL.md#worker-relay).
- **The backup sign-in is weaker than a passkey.** A fake site or someone watching could capture the password, so it
  still needs the 6-digit code, it is off unless you set it up, and the PC notifies you every time it is used. In an
  `about:blank` tab there's no address bar to check, so prefer the passkey there.
- **A PC name you choose yourself.** the Control Center lets you pick the PC's name instead of Roost's made-up one, and says it
  isn't recommended. A made-up name is one of about 590 million; one you choose (like `jordan-macbook`) can be guessed.
  The name is the backup sign-in's username, and its meeting point's key is made from it, so whoever guesses it can
  reach the backup sign-in and try passwords. Each try still needs the password and a 6-digit code, wrong tries lock
  the route, and the PC notifies you. Passkey sign-ins don't use the name. With backup sign-in off, the name isn't
  listened for at all.
- **The message services see some metadata.** They see when a viewer contacts a PC, roughly how big the encrypted
  notes are, and the IP addresses of both ends. So do the public STUN servers both ends use to discover their
  addresses.
- **Roost isn't code-signed yet.** Releases carry a SHA-256 checksum that the installer checks, but no Authenticode
  signature, so Windows SmartScreen can't vouch for them. Install only with the official command or from the official GitHub
  releases, and check what you run.
- **Roost sees and controls everything you can.** Windows asks for no permission to capture the screen or send input;
  with Control admin apps on, Roost runs as administrator.
  Anyone who can sign in can do anything you can do on the PC.
- **Never pair someone else's device.** Scammers ask people to install remote-control tools. Nobody genuine will ask
  you for a Roost pairing link or code.

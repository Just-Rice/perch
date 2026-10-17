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
- **Guessing is slow.** Five failures lock that way of signing in for a minute, doubling up to an hour. Codes work
  once.
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
- **werift doesn't check DTLS handshake signatures.** The WebRTC library on the Mac checks that the browser's
  certificate matches the one announced for the session, but not the handshake signature proving the browser holds
  its private key. Perch's design doesn't rely on that check: the browser fully verifies the Mac, every sign-in proof
  answers a random number sent inside one specific encrypted session and must come back inside it, and the Mac sends
  nothing private before sign-in. See [PROTOCOL.md, Binding](docs/PROTOCOL.md#binding).
- **The backup sign-in is weaker than a passkey.** A fake site or someone watching could capture the password, so it
  still needs the 6-digit code, it is off unless you set it up, and the Mac notifies you every time it is used. In an
  `about:blank` tab there's no address bar to check, so prefer the passkey there.
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

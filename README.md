# Perch

**Your Mac, from any browser.** See and use your Mac from your phone, a tablet or another computer: the screen, the
sound, the mouse and keyboard. Free and open source, with no account and no servers in between.

**[just-rice.github.io/perch](https://just-rice.github.io/perch/)** · [Connect](https://just-rice.github.io/perch/connect.html) ·
[Privacy](https://just-rice.github.io/perch/privacy.html) · [Security](SECURITY.md)

> Perch is a **beta**, so far tested on one Mac. Please [report problems](https://github.com/Just-Rice/perch/issues).

## Install on a Mac

Open **Terminal** (Applications › Utilities), paste this line and press Return:

```
curl -fsSL https://just-rice.github.io/perch/install.sh | bash
```

It downloads the latest release from this repository, checks it against its published checksum, puts Perch in your
Applications folder and opens it. Perch lives in the menu bar and opens its **Setup** page in your browser, which
walks you through the rest:

1. **Two macOS permissions.** Screen & System Audio Recording shows your screen and plays its sound. Accessibility
   lets Perch click and type for you.
2. **Your authenticator app** (Apple Passwords, Google Authenticator, 1Password, …) for the 6-digit codes.
3. **Pairing your first device.** Scan the code Setup shows. Your device makes a passkey (Face ID or Touch ID), then
   asks for a 6-digit code.

After that, open [the website](https://just-rice.github.io/perch/connect.html) on that device to sign in and use your
Mac. It also works inside an `about:blank` tab.

**Why a Terminal command?** Perch isn't registered with Apple's paid developer programme, and macOS blocks
unregistered apps downloaded in a browser. Files fetched by Terminal aren't marked that way. Prefer not to? Download
`Perch-x.y.z.zip` from the [latest release](https://github.com/Just-Rice/perch/releases/latest), move Perch to
Applications and open it. When macOS refuses, go to System Settings › Privacy & Security and click **Open Anyway**.

**Needs:**

- **The Mac:** Apple silicon (M1 or later), macOS 14 Sonoma or later. Intel isn't supported yet.
- **The viewing device:** a recent Safari, Chrome, Edge or Firefox.
- **While you use it**, the Mac must be on, awake and logged in.

**Uninstall:** use Setup's **Uninstall Perch** button, or run
`curl -fsSL https://just-rice.github.io/perch/uninstall.sh | bash`.

## How it works

```
 your browser                       public message services                 your Mac
 (just-rice.github.io/perch)        (MQTT, scrambled notes only)            (Perch menu bar app)
        │   "here's how to reach me"  ──────────────►  ◄────────────────────────  │
        │                                                                        │
        └──────────── direct, encrypted WebRTC connection (screen, sound, input) ┘
```

- **The website** is the screen and the remote: plain HTML and JavaScript on GitHub Pages (`site/`).
- **The Mac app** (`host/app/`, Swift, Command Line Tools only) records the screen and sound with ScreenCaptureKit,
  compresses them with the Mac's hardware (VideoToolbox H.264, AudioToolbox Opus) and performs clicks and keys with
  Quartz events. It runs the host as a child process with a bundled Node.js.
- **The host** (`host/node/`) finds viewers through public MQTT brokers, connects with WebRTC
  ([werift](https://github.com/shinyoshiaki/werift-webrtc)), checks every sign-in, and serves the local Setup page.
- **Signing in** takes a passkey plus a 6-digit code, both checked by the Mac. Every proof is tied to that exact
  connection. An optional backup sign-in uses the Mac's name, a password (checked with OPAQUE, so the password
  itself is never sent) and the code.

[docs/PROTOCOL.md](docs/PROTOCOL.md) is the full contract between the three parts; [SECURITY.md](SECURITY.md) explains
what Perch protects against and its known limitations.

## Building from source

You need a Mac with Apple silicon, Xcode's Command Line Tools (`xcode-select --install`), Node.js 22 or later and,
for the tests, Google Chrome and ffmpeg.

```
git clone https://github.com/Just-Rice/perch && cd perch
(cd host/node && npm ci && node scripts/bundle.mjs)
NODE_BIN="$(host/app/test/fetch-node.sh .build/node v24.22.0)"     # the official Node.js, checksum-checked
host/scripts/make-app.sh --host-bundle host/node/dist --node "$NODE_BIN"   # -> build/Perch.app
open build/Perch.app
```

A build of your own is signed ad hoc, so macOS asks for its two permissions again after every rebuild.
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) covers running the parts separately, the test suites and releases.

## Licence

Apache 2.0 ([LICENSE](LICENSE)). Third-party code and credits: [THIRD_PARTY.md](THIRD_PARTY.md).

# Roost

**Your PC, from anywhere.** See and use your Windows PC from your phone, a tablet or another computer, in a
browser: the screen, the sound, the mouse and the keyboard. Free and open source, with no account and no servers in
between.

**[just-rice.github.io/perch/windows](https://just-rice.github.io/perch/windows/)** ·
[Connect](https://just-rice.github.io/perch/windows/connect.html) · [Security](SECURITY.md)

- **Phones, tablets and computers:** touch, touchpad mode, mouse, keyboard and sound, with a Key deck for the keys a
  phone doesn't have (Win, Alt+Tab, Ctrl+Shift+Esc, F-keys…).
- **Two-step sign-in checked by your PC:** a passkey (Face ID, Touch ID, Windows Hello), then a 6-digit code.
- **Private:** black out the PC's own screen while you're connected, and lock it when you leave.
- **One window at a time:** show a single window instead of the whole desktop, reshaped to fit your phone.
- **Every display**, with a map of how they're arranged.
- **Clipboard both ways**, pictures too. **Talk through your PC:** your microphone, played on its speakers.
- **Guest links:** let someone watch your screen for a while, without being able to touch anything.
- **Strict Wi-Fi:** an optional relay in a free Cloudflare account of your own (TURN, or a small Worker that needs
  no payment details, with a Node.js / Cloudflare Quick Tunnel backup): [core/relay/](../core/relay/README.md).
- **Control admin apps:** optionally, Roost can click and type into apps that run as administrator.
- **Windows 10 (1903 or later) and Windows 11, on x64 and ARM64.** No administrator rights needed to install.

> Roost is built on **[Perch](https://github.com/Just-Rice/perch) by [Just-Rice](https://github.com/Just-Rice)**,
> the Mac original, and shares its protocol and security model. It lives in Perch's repository, in `windows/`, and
> on Perch's website; its releases are the ones tagged `windows-v…`. It is a **beta**. See [Credits](#credits).

## Install

Open **PowerShell** (Start › type "PowerShell"), paste this line and press Enter:

```
irm https://just-rice.github.io/perch/windows/install.ps1 | iex
```

It downloads the latest release for your PC's processor from this repository, checks it against its published
checksum, installs Roost for you only (in `%LOCALAPPDATA%\Programs\Roost`, no administrator prompt) and starts it.
Roost lives in the notification area by the clock; its **Control Center** opens in your browser and walks you
through the rest:

1. **Your authenticator app** (Microsoft Authenticator, Google Authenticator, 1Password, …) for the 6-digit codes.
2. **Pairing your first device.** Scan the code the Control Center shows. Your device makes a passkey, then asks for
   a 6-digit code.

After that, open [the website](https://just-rice.github.io/perch/windows/connect.html) on that device to sign in.

**Why PowerShell?** Roost isn't signed with a paid code-signing certificate, so Windows SmartScreen warns about it
when it's downloaded in a browser. Prefer the zip? Download `Roost-x.y.z-win-x64.zip` (or `-arm64`) from the
[latest Windows release](https://github.com/Just-Rice/perch/releases?q=windows-v&expanded=true), unzip it and run `install.ps1`, or
choose **More info › Run anyway** when SmartScreen asks.

**Needs:** Windows 10 version 1903 or later (2004 or later for the privacy curtain and for sound without echo), a
recent Safari, Chrome, Edge or Firefox on the viewing device, and the PC on, awake and signed in.

**Uninstall:** the Control Center's **Uninstall Roost** button, or
`irm https://just-rice.github.io/perch/windows/uninstall.ps1 | iex`.

## How it works

```
 your browser                       public message services                  your PC
 (just-rice.github.io/perch/windows)     (MQTT, sealed notes only)                (Roost, in the tray)
        │   "here's how to reach me"  ──────────────►  ◄────────────────────────  │
        │                                                                        │
        └──────────── direct, encrypted WebRTC connection (screen, sound, input) ┘
```

- **The website** (`site/`) is the viewer: plain HTML and JavaScript on GitHub Pages.
- **roost.exe** (`app/`, Rust) is the Windows app: the tray icon and its panel, screen capture with DXGI Desktop
  Duplication (GDI as a fallback), H.264 with OpenH264, sound with WASAPI process loopback and Opus, and the
  viewer's mouse and keyboard with SendInput. It runs the host with a bundled Node.js.
- **The host** (`host/`) finds viewers through public MQTT brokers, connects with WebRTC, checks every sign-in, and
  serves the local Control Center (`host/setup/`).
- **The relay** (`relay/`, optional) is a Cloudflare Worker you deploy for networks that block WebRTC.

[docs/PROTOCOL.md](docs/PROTOCOL.md) is the contract between the parts, [docs/WINDOWS-APP.md](docs/WINDOWS-APP.md)
the Windows app's side of it, [docs/BRAND.md](docs/BRAND.md) Roost's look and words, and
[SECURITY.md](SECURITY.md) what Roost protects against.

## Building from source

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). In short, on Windows with Rust and Node.js 22+:

```
git clone https://github.com/Just-Rice/perch && cd perch/windows
(cd host && npm ci)
cd app && cargo build --release
target\release\roost.exe --node node --host ..\host\src\main.mjs
```

## Credits

Roost exists because of **[Perch](https://github.com/Just-Rice/perch)**, created by
**[Just-Rice](https://github.com/Just-Rice)**. Perch is the original: a way to reach a Mac from any browser with no
account and no servers in between. Nearly everything that makes Roost trustworthy was designed and built there first:

- the sign-in: passkeys plus authenticator codes, checked by the computer itself, with every proof bound to its
  connection; the OPAQUE backup password; pairing and guest links;
- the way a device finds its computer through sealed notes on public message servers, and the direct WebRTC
  connection that follows;
- the Cloudflare relays (TURN, the Worker, and the Node.js / Quick Tunnel backup) for strict networks;
- the host, its adaptive picture quality, and the viewer's foundations: touch, keyboard, clipboard, displays and one
  window at a time.

Roost brings that to Windows: a new native app (`app/`), a Windows port of the host and relays, and its own design for
the website, the viewer and the Control Center. If you have a Mac, use Perch.

## Licence

Apache 2.0 ([LICENSE](LICENSE)), the same as Perch. [NOTICE](NOTICE) says what comes from Perch;
[THIRD_PARTY.md](THIRD_PARTY.md) lists everything else Roost uses.

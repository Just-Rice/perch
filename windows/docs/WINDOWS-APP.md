# The Windows app (`app/`, Rust) and how it differs from Perch's Mac app

`roost.exe` is the native half of Roost, in the place of Perch's Swift app. It speaks **the same IPC** to the Node host
(docs/PROTOCOL.md, "App ⇄ host process"): same frame format, same frame types, same commands and events, unless
listed here. This file is the contract for the Windows-specific parts; change it first, then the code.

## Install layout (per user, no administrator needed)

```
%LOCALAPPDATA%\Programs\Roost\
  roost.exe                 the app (tray, capture, encoding, input)
  VERSION                   e.g. 0.1.0 (the host compares it with the version running: "restart to finish updating")
  node\node.exe             the official Node.js (bundled, checksum-checked at build time)
  host\roost-host.mjs       the host bundle (host/scripts/bundle.mjs), with host\setup\ next to it
%LOCALAPPDATA%\Roost\       ROOST_HOME: config.json, secrets.dpapi, roost.log
```

Start with Windows: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Roost = "<dir>\roost.exe" --startup`, or,
with "Control admin apps" on, a scheduled task `\Roost\Roost` (at log on, highest privileges) instead.

## Environment the app gives the host

| Variable | Value |
|---|---|
| `ROOST_APP_VERSION` | the app's version |
| `ROOST_APP_EXE` | full path of roost.exe (the host runs `roost.exe --secrets read|write` through it) |
| `ROOST_HOME` | `%LOCALAPPDATA%\Roost` (tests set their own) |
| `ROOST_INSTALL_DIR` | the folder roost.exe is in |

`PERCH_*` test variables are spelled `ROOST_*` (ROOST_TEST, ROOST_HOME, ROOST_SECRETS, ROOST_BROKERS, …).

## Secrets

Kept in `%ROOST_HOME%\secrets.dpapi`: the same JSON object Perch keeps in the Keychain, encrypted with DPAPI
(`CryptProtectData`, current user, entropy `"roost secrets v1"`). The host never handles DPAPI itself:

- `roost.exe --secrets read --home <dir>`: prints the decrypted JSON on stdout (exit 0), or exit 3 when there is
  no file yet, exit 1 on any other failure (message on stderr).
- `roost.exe --secrets write --home <dir>`: reads the JSON on stdin, writes the file atomically (temp + rename).

With `ROOST_SECRETS=file` (tests, and any platform without roost.exe) the host uses plain `secrets.json` as before.

## HELLO

```
{app:"Roost", version, ipc:1, os:"windows", osVersion:"10.0.22631", arch:"x64"|"arm64", synthetic,
 soundTap, permissions:{screen:true, accessibility:true, elevated}, displays, loginItem,
 features:{curtain, encoder:"Media Foundation (NVIDIA)"|"OpenH264"|…, elevatedTask}}
```

- Windows has no Screen Recording or Accessibility permission: `screen` and `accessibility` are always true.
- `elevated`: roost.exe runs as administrator. Without it Windows' UIPI stops clicks and keys reaching apps that run
  as administrator (Task Manager, installers, admin consoles) and the secure desktop (UAC prompts) can't be seen.
  The Control Center explains this and offers **Control admin apps** (below) instead of Perch's permission steps.
- `soundTap`: the PC's own speakers can be turned down while a viewer listens (true on Windows 10 2004+).
- `features.curtain`: the black-out curtain can be left out of the picture (`WDA_EXCLUDEFROMCAPTURE`, Windows 10
  2004+). Without it the privacy curtain is refused.

## Displays and coordinates

Display ids are stable 32-bit hashes of the monitor's device path. `x`, `y`, `width`, `height` are **physical
pixels** in the virtual desktop (roost.exe is per-monitor DPI aware v2), `main` is the primary monitor. Input
coordinates (0..1 of the picture) map onto the same pixels.

## Extra commands and events

| | |
|---|---|
| command `elevation {on}` | on: register the "highest privileges" scheduled task and restart elevated through it (Windows asks once, with UAC); off: remove it and go back to the Run key. Answered by event `elevation {ok, elevated, task, error?}`. |
| event `elevation {elevated, task}` | also sent after HELLO |
| command `request-permission`, `reset-permission` | answered at once with `permissions` / `permission-reset {ok:false, error:"Not needed on Windows."}` |

Everything else in PROTOCOL.md's IPC section applies unchanged. Menu actions from the tray are the same list.

## Input on Windows

- Keys go out as **scan codes** (`SendInput` with `KEYEVENTF_SCANCODE`, plus `KEYEVENTF_EXTENDEDKEY` where needed), so
  the PC applies its own keyboard layout, as with a keyboard plugged into it. `Meta` is the Windows key.
- Text (`txt`, and keys with no position) goes out as `KEYEVENTF_UNICODE`.
- Buttons: left, middle, right; `n` (click count) is left to Windows' own double-click timing.
- Scroll: `MOUSEEVENTF_WHEEL` / `HWHEEL` in units of 120 per 100 CSS pixels (fractions carried over).
- `sys` keys: `brightnessUp` / `brightnessDown` change the built-in display's brightness (WMI); the keyboard-light
  keys are ignored.
- Paste after `clipboard-set {paste:true}` presses **Ctrl+V**.
- The viewer's Dock has "⌘ is Ctrl" on by default when the viewer is an Apple device, so ⌘C/⌘V/⌘Z do the expected
  thing on the PC.

`--echo-input` reports each planned event as `{type:"move", x, y, dx?, dy?}`, `{type:"down"|"up", button, x, y}`,
`{type:"wheel", dy, dx, x, y}`, `{type:"key", scan, ext, down}`, `{type:"text", s}`, `{type:"sys", key}`.

## Windows features in place of macOS ones

| Perch (macOS) | Roost (Windows) |
|---|---|
| ScreenCaptureKit | DXGI Desktop Duplication (Windows 8+), GDI fallback |
| VideoToolbox H.264 | Media Foundation hardware encoder when present, else OpenH264 (always works, also on N editions) |
| ScreenCaptureKit sound, Core Audio tap | WASAPI loopback of the default output; speakers turned down with the endpoint volume while connected |
| AudioToolbox Opus | libopus |
| Quartz events | SendInput |
| Accessibility focused element | UI Automation focused element (edit / document controls, `IsPassword`) |
| Curtain windows left out of the capture | topmost black windows with `WDA_EXCLUDEFROMCAPTURE`, click-through; Esc ×3 at the PC lifts it |
| Lock screen | `LockWorkStation`; locked state from WTS session notifications |
| Keep Mac awake | `SetThreadExecutionState` |
| Menu bar item | tray icon with Roost's own flyout panel |
| Notifications | tray balloon / toast |
| Login item | HKCU Run key, or the elevated scheduled task |
| Keychain | DPAPI file |

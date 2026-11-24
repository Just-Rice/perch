# Developing Roost

## Layout

| Path | What |
|---|---|
| `app/` | roost.exe, the Windows app (Rust): `src/` portable core (IPC, input planning, key map, H.264/Opus, capture loop), `src/sys/windows/` everything Windows-only |
| `host/` | The host (Node.js): `src/` rendezvous, WebRTC, sign-in, Control Center server; `setup/` the Control Center page; `test/` |
| `site/` | The website (GitHub Pages): front page, `connect.html` sign-in and viewer, `install.ps1`, `uninstall.ps1` |
| `site/js/shared/` | Code shared by the website and the host: MQTT, sealed rendezvous, channel binding, constants |
| `relay/` | The optional Cloudflare Worker relay, and `relay/node/` its Node.js backup |
| `scripts/` | `set-version.mjs`, `package.ps1` (the release zip) |
| `tests/site/`, `tests/e2e/` | Website tests; end to end (website + host + stand-in app, or + the real roost.exe) |
| `docs/` | `PROTOCOL.md` (the contract between the parts), `WINDOWS-APP.md` (roost.exe's side), `BRAND.md` |

## Running it

On Windows, with [Rust](https://rustup.rs) and Node.js 22 or later:

```
(cd host && npm ci)
cd app
cargo build --release
target\release\roost.exe --node node --host ..\host\src\main.mjs
```

Useful flags (`roost.exe --help`): `--synthetic` (a moving test pattern and a tone instead of the real screen and
sound), `--echo-input` (report input instead of performing it), `--no-ui` (no tray icon), `--selftest`
(checks the encoder, Opus, displays, capture and sound on this PC).

**On a Mac or Linux** the portable core builds and runs too: `cargo test`, and `cargo run -- --synthetic
--echo-input --no-ui --node node --host ../host/src/main.mjs` runs the real app (test pattern only) against the
real host. Type-check or build the Windows app without Windows using
[cargo-xwin](https://github.com/rust-cross/cargo-xwin) and LLVM:

```
PATH="/opt/homebrew/opt/llvm/bin:$PATH" cargo xwin build --release --target x86_64-pc-windows-msvc
```

A local copy of the website with a local test broker:

```
python -m http.server 8765 --bind 127.0.0.1 --directory site   # then open http://localhost:8765/connect.html?demo=1
```

The website honours `?test=1&brokers=…` and `?demo=1` only on `localhost`; the host honours its `ROOST_*` test
variables (docs/PROTOCOL.md, "Test mode") only with `ROOST_TEST=1`.

## Tests

None of them use the public brokers, a real passkey or real input.

```
(cd app && cargo test)                                                 # roost.exe's core
(cd host && node --test --test-concurrency=1 'test/*.test.mjs')        # host, Control Center
node --test --test-concurrency=1 'tests/site/*.test.mjs'               # website
node --test --test-concurrency=1 tests/e2e/full.test.mjs               # website + host, every sign-in route
node --test --test-concurrency=1 tests/e2e/app.test.mjs                # + the real roost.exe (--synthetic)
```

CI (`.github/workflows/ci.yml`) runs all of these on GitHub's Windows runners, x64 and ARM64.

## Releases

1. `node scripts/set-version.mjs 0.2.0`, commit.
2. `git tag v0.2.0 && git push origin main v0.2.0`.
3. `.github/workflows/release.yml` builds roost.exe for x64 and ARM64, bundles the host and the official Node.js
   (checksum-checked), and publishes `Roost-0.2.0-win-x64.zip` / `-win-arm64.zip` with `.sha256` files. `install.ps1`
   and the update check pick them up. A tag with a suffix (`v0.2.0-alpha.1`) is a pre-release.

Code signing: Roost is unsigned for now. A code-signing certificate would remove SmartScreen's warning; add it as a
signing step in release.yml (`signtool sign`) before packaging.

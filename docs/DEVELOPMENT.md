# Developing Perch

## Layout

| Path | What |
|---|---|
| `site/` | The website (GitHub Pages): `index.html` front page, `connect.html` sign-in and viewer, `install.sh`, `uninstall.sh` |
| `site/js/shared/` | Code shared by the website and the host: MQTT client, sealed rendezvous, channel binding, constants |
| `host/app/` | The Swift menu bar app (SwiftPM; Command Line Tools only) |
| `host/node/` | The host: `src/` (rendezvous, WebRTC, sign-in, Setup server), `setup/` (the Setup page), `test/` |
| `host/scripts/` | `make-app.sh` (assemble Perch.app), `set-version.sh`, signing helpers |
| `tests/site/` | Website tests (unit and headless Chrome) |
| `tests/e2e/` | End to end: `full.test.mjs` (website + host + stand-in app), `app.test.mjs` (website + host + real app) |
| `docs/PROTOCOL.md` | The contract between the parts — change it first, then the code |

## Running the parts

The app runs the host itself. For development, point it at the source and at Homebrew's Node:

```
swift build -c release --package-path host/app
host/app/.build/release/Perch --node "$(command -v node)" --host host/node/src/main.mjs
```

Useful flags: `--synthetic` (a test pattern and tone instead of the real screen and sound; no Screen Recording
needed), `--echo-input` (report input instead of performing it), `--no-ui` (no menu bar item), `--selftest`.
`Perch --help` lists them all.

Run from Terminal, the app borrows Terminal's permissions; launched with `open`, Perch.app is judged on its own.
Test the real permission flow with `open build/Perch.app`.

A local copy of the website with the local test broker:

```
python3 -m http.server 8765 --bind 127.0.0.1 --directory site   # then open http://localhost:8765/connect.html
```

The website honours `?test=1&brokers=ws://127.0.0.1:<port>/mqtt` (and `?demo=1`, a viewer with a test picture and
no network) **only** on `localhost` / `127.0.0.1`. The host honours its test variables (`PERCH_TEST=1` plus
`PERCH_HOME`, `PERCH_BROKERS`, `PERCH_TEST_ORIGIN`, `PERCH_RP_ID`, …, see docs/PROTOCOL.md "Test mode") only when
`PERCH_TEST=1`.

## Tests

Nothing in the tests uses the public brokers, a real passkey or real input: there is a local MQTT broker
(`tests/e2e/broker.mjs`), every Chrome tab gets a CDP virtual authenticator (`tests/e2e/cdp.mjs`), and the app runs
with `--echo-input`.

```
(cd host/node && node --test --test-concurrency=1 'test/*.test.mjs')    # host: units, sessions, Setup page
node --test --test-concurrency=1 'tests/site/*.test.mjs'                 # website
node --test --test-concurrency=1 tests/e2e/full.test.mjs                 # website + host, every sign-in route
swift build -c release --package-path host/app && node --test tests/e2e/app.test.mjs   # + the real app
host/app/test/run.sh                                                      # the app: self-test, IPC, real capture, bundle
```

`PERCH_E2E_APP=/path/to/Perch.app node --test tests/e2e/app.test.mjs` runs the last end-to-end test against a
packaged app (its bundled Node and host). Long browser runs: prefix with `caffeinate -i` so the Mac doesn't sleep.

## Releases

1. `host/scripts/set-version.sh 0.2.0` (updates Info.plist, the app's fallback version and host/node/package.json).
2. Commit, then `git tag v0.2.0 && git push origin main v0.2.0`.
3. `.github/workflows/release.yml` builds Perch.app on GitHub's Mac, signs it with Perch's certificate
   (`PERCH_SIGNING_P12`, `PERCH_SIGNING_P12_PASSWORD` secrets), and publishes `Perch-0.2.0.zip` with its checksum.
   `install.sh` and the app's update check pick it up.

**The signing certificate** is a long-lived self-signed code-signing certificate (`host/scripts/signing-cert.sh`).
macOS ties Perch's permissions to it, so it must never change: a new certificate means every user grants the two
permissions again. Keep the `.p12` and its password backed up somewhere safe, and never commit them.
